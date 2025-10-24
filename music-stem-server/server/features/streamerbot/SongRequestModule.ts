/**
 * Song Request submodule
 *
 * Sends song requests to RabbitMQ for job-handlers to process
 * Handles song request data in the db
 * Handles the channel point redemption for special song requests
 * Gives chatters helpful info about their song requests
 *   via progress messages and some ! commands
 */
import { sql } from 'kysely';
import { StreamerbotEventPayload } from '@streamerbot/client';
import StreamerbotWebSocketClient from '../../StreamerbotWebSocketClient';
import { db } from '../../database';
import * as queries from '../../queries';
import { Queues, Payloads, JobInterface } from '../../../../shared/RabbitMQ';
import { createLogger, isURL, formatTime, normalizeURL } from '../../../../shared/util';
import { WebSocketMessage } from '../../../../shared/messages';
import WebSocketCoordinatorServer from '../../WebSocketCoordinatorServer';

interface SongRequestOptions {
  priority: number,
  noShenanigans: boolean,
  maxDuration: number,
  minViews?: number,
  twitchRewardId?: string,
  twitchRedemptionId?: string,
  songRequestToReplaceId?: number,
}

const SONG_REQUEST_MAX_DURATION = 60 * 6;
const LONG_SONG_REQUEST_MAX_DURATION = 60 * 12;
const DEFAULT_REQUESTER_NAME = 'danny_the_liar';

export default class SongRequestModule {
  private client: StreamerbotWebSocketClient;
  private wss: WebSocketCoordinatorServer;
  private jobs: JobInterface;
  private successCallbacks: {
    [id: number]: (songTitle: string, numPreviousRequests: number, numPreviousRequestsBySameRequester: number) => void
  } = {};
  private failureCallbacks: { [id: number]: (errorType: string) => void } = {};
  private userCommandHistory: { [username: string]: [string, number][] } = {};
  private rejectedSongRequests: { [username: string]: string } = {};
  private removedSongRequests: { [username: string]: string } = {};

  public static MINIMUM_QUERY_LENGTH = 4;
  public static PRIORITY_REQUEST_VALUE = 5;

  constructor(
    client: StreamerbotWebSocketClient,
    wss: WebSocketCoordinatorServer
  ) {
    this.client = client;
    this.wss = wss;

    const beginSongRequest = async (payload: {
      rawInput: string,
      user: string,
    }) => {
      try {
        const query = await this.prepareUserSongRequest(
          payload.rawInput,
          payload.user,
          await this.songRequestMaxCountForUser(payload.user)
        );

        const danceOfEternityURLs = [
          'https://www.youtube.com/watch?v=eYCYGpu0OxM',
          'https://open.spotify.com/track/7FTf3bJuCq5UYHjUwggKNB',
        ];
        if (query.match(/dance of eternity/i) || danceOfEternityURLs.includes(query)) {
          await this.client.doAction('!danceofeternity');
          await this.client.sendTwitchMessage(`@${payload.user} probably not`);
          return;
        }

        await this.handleUserSongRequest(
          query,
          payload.user,
        );
      } catch (e) {
        this.log('Song request error', e);
      }
    };

    this.client.registerCustomEventHandler('Song Request', async (payload) => {
      if (!payload.isFollowing && !payload.isSubscribed && !payload.isModerator) {
        await this.client.sendTwitchMessage(`@${payload.user} Song requests are available to anyone following the channel!`);
        await this.client.doAction('!srrules');
        this.rejectedSongRequests[payload.user] = payload.rawInput;
      } else {
        await beginSongRequest(payload);
      }
    });

    this.client.on('Twitch.Follow', async (payload) => {
      const user = payload.data.user_name;
      if (this.rejectedSongRequests[user]) {
        await this.client.sendTwitchMessage(`@${user} Processing your song request now!`);
        await beginSongRequest({
          rawInput: this.rejectedSongRequests[user],
          user,
        });
        delete this.rejectedSongRequests[user];
      }
    });

    this.client.registerCommandHandler('!srfor', async (payload) => {
      // Allow a moderator to request a song for someone else
      // Bypass most of the checks, since it's a moderator privilege
      try {
        const parts = payload.message.replace(/^\s*for\s+/, '').split(' ');
        const forUser = parts[0].replace(/^@/, '');
        const query = parts.slice(1).join(' ');
        await this.handleUserSongRequest(
          query,
          forUser,
          {
            // use moderator's limits instead of user's
            maxDuration: await this.songRequestMaxDurationForUser(payload.user),
            minViews: await this.songRequestMinViewsForUser(payload.user),
          },
        );
      } catch (e) {
        this.log('Song request !srfor error', e);
      }
    });

    this.client.registerCommandHandler('!replace', async (payload) => {
      const { songRequest, query: strippedQuery, isAmbiguous } = await this.disambiguate(
        payload.user, payload.message, 'Use !replace <number> <query> to select which song to replace.'
      );
      if (isAmbiguous) return;
      if (!songRequest) {
        await this.client.sendTwitchMessage(`@${payload.user} You don't have any active song requests to change!`);
        return;
      }

      let query;
      try {
        query = this.prepareSongRequestQuery(strippedQuery);
      } catch (err) {
        await this.client.doAction('!how');
        throw err;
      }
      await this.handleUserSongRequest(
        query,
        payload.user,
        {
          priority: songRequest.priority,
          noShenanigans: Boolean(songRequest.noShenanigans),
          songRequestToReplaceId: songRequest.id,
        },
      );
    });
    this.client.registerCommandHandler('!remove', async (payload) => {
      if (payload.message.toLowerCase() === 'all') {
        const songRequests = await queries.songRequestsByUser(payload.user);
        if (songRequests.length > 0) {
          const effectiveCreatedAt = songRequests[0].effectiveCreatedAt;
          this.removedSongRequests[payload.user] = effectiveCreatedAt;

          await db.updateTable('songRequests')
            .set({ status: 'cancelled', fulfilledAt: new Date().toUTCString() })
            .where('id', 'in', songRequests.map(sr => sr.id))
            .execute();

          songRequests.forEach(songRequest =>
            this.wss.broadcast({
              type: 'song_request_removed',
              songRequestId: songRequest.id,
            })
          );

          await this.client.sendTwitchMessage(`@${payload.user} All of your song requests have been removed! o7`);
        }
        return;
      }

      const { songRequest, isAmbiguous } = await this.disambiguate(
        payload.user, payload.message, 'Use !remove <number> to select which song to remove.'
      );
      if (isAmbiguous) return;
      if (!songRequest) {
        await this.client.sendTwitchMessage(`@${payload.user} You don't have any queued song requests to remove!`);
        return;
      }

      const effectiveCreatedAt = songRequest.effectiveCreatedAt;
      this.removedSongRequests[payload.user] = effectiveCreatedAt;

      await db.updateTable('songRequests')
        .set({ status: 'cancelled', fulfilledAt: new Date().toUTCString() })
        .where('id', '=', songRequest.id)
        .execute();
      this.wss.broadcast({
        type: 'song_request_removed',
        songRequestId: songRequest.id,
      });
      await this.client.sendTwitchMessage(`@${payload.user} ${songRequest.artist} - ${songRequest.title} has been removed.`);
    });
    this.client.registerCommandHandler('!songs', async (payload) => {
      const songRequests = await queries.songRequestsByUser(payload.user);
      if (!songRequests.length) {
        await this.client.sendTwitchMessage(`@${payload.user} You don't have any songs on the wheel!`);
      } else {
        const songList = songRequests.map((sr, i) =>
          `${i + 1}: ${[sr.artist, sr.title].filter(s => s).join(' - ')}`
        ).join(', ');

        if (songRequests.length === 1) {
          await this.client.sendTwitchMessage(`@${payload.user} Your song: ${songList}`);
        } else {
          await this.client.sendTwitchMessage(`@${payload.user} Your ${songRequests.length} songs: ${songList}`);
        }
      }
    });
    this.client.registerCommandHandler('!bump', async (payload) => {
      const { songRequest, isAmbiguous } = await this.disambiguate(
        payload.user, payload.message, 'Use !bump <number> to select which song to get more wheel entries for.'
      );
      if (isAmbiguous) return;
      if (!songRequest) {
        await this.client.sendTwitchMessage(`@${payload.user} You don't have any queued song requests to bump!`);
        return;
      }

      const viewer = await this.client.getViewer(payload.user);
      const user = await this.client.getUser(payload.user);
      let availableBumps = user.availableBumps;
      let userUpdate = db.updateTable('users').where('id', '=', user.id);
      if (viewer?.subscribed) {
        // Check to see if subscriber has gotten their free bump of the stream
        const currentStreamId = (await queries.currentStreamHistory())[0].id;
        if (user.lastFreeBumpStreamHistoryId !== currentStreamId) {
          availableBumps += 1;
          await this.client.sendTwitchMessage(`@${payload.user} You've been given a free bump of the day, thanks for subscribing! dannyt75Heart`);
        }
        userUpdate = userUpdate.set('lastFreeBumpStreamHistoryId', currentStreamId);
      }

      if (availableBumps > 0) {
        // Bump the song - now increases wheel entries instead of queue position
        userUpdate = userUpdate.set('availableBumps', availableBumps - 1);
        await db.updateTable('songRequests')
          .where('id', '=', songRequest.id)
          .set(eb => ({ bumpCount: eb('bumpCount', '+', 1) }))
          .execute();
        const currentBumpCount = (await db.selectFrom('songRequests')
          .select('bumpCount')
          .where('id', '=', songRequest.id)
          .execute())[0].bumpCount;
        await this.client.sendTwitchMessage(`@${payload.user} ${songRequest.artist} - ${songRequest.title} now has ${currentBumpCount + 1} entries in the wheel!`);
        this.wss.broadcast({ type: 'song_request_moved', songRequestId: songRequest.id });
      } else {
        await this.client.sendTwitchMessage(`@${payload.user} You don't have any bumps available to use!`);
      }
      await userUpdate.execute();
    });

    this.client.registerCommandHandler('!longsr', async (payload) => {
      const user = await this.client.getUser(payload.user);
      const currentStreamId = (await queries.currentStreamHistory())[0].id;
      if (user.lastLongSongStreamHistoryId === currentStreamId) {
        await this.client.sendTwitchMessage(`@${payload.user} You can only request one Long Song per stream!`);
        throw new Error('ONE_LONG_SONG_PER_DAY');
      }

      if (user.availableLongSongs > 0) {
        const query = await this.prepareUserSongRequest(
          payload.message,
          payload.user,
          await this.songRequestMaxCountForUser(payload.user)
        );
        await this.handleUserSongRequest(
          query,
          payload.user,
          {
            maxDuration: LONG_SONG_REQUEST_MAX_DURATION,
          },
        );
        await db.updateTable('users')
          .where('id', '=', user.id)
          .set({
            availableLongSongs: user.availableLongSongs - 1,
            lastLongSongStreamHistoryId: currentStreamId
          })
          .execute();
      } else {
        await this.client.sendTwitchMessage(`@${payload.user} You don't have any long song requests available to use!`);
      }
    });

    this.client.registerTwitchRedemptionHandler('Long Song Request', async (payload) => {
      try {
        const user = await this.client.getUser(payload.user);
        const currentStreamId = (await queries.currentStreamHistory())[0].id;
        if (user.lastLongSongStreamHistoryId === currentStreamId) {
          await this.client.sendTwitchMessage(`@${payload.user} You can only request one Long Song per stream!`);
          throw new Error('ONE_LONG_SONG_PER_DAY');
        }

        const query = await this.prepareUserSongRequest(
          payload.input,
          payload.user,
          await this.songRequestMaxCountForUser(payload.user)
        );
        await this.handleUserSongRequest(
          query,
          payload.user,
          {
            maxDuration: LONG_SONG_REQUEST_MAX_DURATION,
            twitchRewardId: payload.rewardId,
            twitchRedemptionId: payload.redemptionId,
          },
        );

        await db.updateTable('users')
          .where('id', '=', user.id)
          .set({ lastLongSongStreamHistoryId: currentStreamId })
          .execute();
      } catch (err) {
        await this.client.updateTwitchRedemption(payload.rewardId, payload.redemptionId, 'cancel');
        await this.client.sendTwitchMessage(`@${payload.user} Long Song Request has been refunded`);
      }
    });
    this.client.registerTwitchRedemptionHandler('Priority Song Request', async (payload) => {
      try {
        const existingRequest = await this.getExistingSongRequest(
          payload.input.trim().toLowerCase(),
          payload.user
        );
        if (existingRequest) {
          await db.updateTable('songRequests')
            .set({ priority: SongRequestModule.PRIORITY_REQUEST_VALUE })
            .where('id', '=', existingRequest.id)
            .execute();
          await this.client.sendTwitchMessage(`@${payload.user} Your song request for ${existingRequest.artist} - ${existingRequest.title} has been given priority!`);
        } else {
          const query = await this.prepareUserSongRequest(
            payload.input,
            payload.user,
            0,
          );
          await this.handleUserSongRequest(
            query,
            payload.user,
            {
              priority: SongRequestModule.PRIORITY_REQUEST_VALUE,
              twitchRewardId: payload.rewardId,
              twitchRedemptionId: payload.redemptionId,
            }
          );
        }
      } catch (err) {
        await this.client.updateTwitchRedemption(payload.rewardId, payload.redemptionId, 'cancel');
        await this.client.sendTwitchMessage(`@${payload.user} Priority Song Request has been refunded`);
      }
    });
    this.client.registerTwitchRedemptionHandler('No Shens Song Request', async (payload) => {
      try {
        const existingRequest = await this.getExistingSongRequest(
          payload.input.trim().toLowerCase(),
          payload.user
        );
        if (existingRequest) {
          await db.updateTable('songRequests')
            .set({ noShenanigans: 1 })
            .where('id', '=', existingRequest.id)
            .execute();
        } else {
          const query = await this.prepareUserSongRequest(
            payload.input,
            payload.user,
            await this.songRequestMaxCountForUser(payload.user)
          );
          await this.handleUserSongRequest(
            query,
            payload.user,
            {
              noShenanigans: true,
              twitchRewardId: payload.rewardId,
              twitchRedemptionId: payload.redemptionId,
            },
          );
        }
      } catch (err) {
        await this.client.updateTwitchRedemption(payload.rewardId, payload.redemptionId, 'cancel');
        await this.client.sendTwitchMessage(`@${payload.user} No Shens Song Request has been refunded`);
      }
    });
    this.client.registerCustomEventHandler<'Twitch.GiftSub' | 'Twitch.GiftBomb'>('add bumps', async (payload) => {
      if (payload.triggerName === 'Gift Subscription' || payload.triggerName === 'Gift Bomb') {
        // @ts-expect-error Twitch.GiftBomb payload definition is incomplete
        const giftedCount: number = payload.gifts || payload.subBombCount || 1;
        // NB: is it worth having an upper limit on number of bumps given?
        if (payload.isTest) return;
        const user = await this.client.getUser(payload.userName);
        await db.updateTable('users')
          .where('id', '=', user.id)
          .set(q => ({ availableBumps: q('availableBumps', '+', giftedCount) }))
          .execute();
        await this.client.sendTwitchMessage(`@${payload.userName} Thank you for gifting ${giftedCount === 1 ? 'a sub' : giftedCount + ' subs'}! ❤️💚💙`);
        // await this.client.sendTwitchMessage(`@${payload.userName} Thanks for gifting ${giftedCount === 1 ? 'a sub' : giftedCount + ' subs'}! ` +
        //   `dannyt75Heart You've been given ${giftedCount === 1 ? 'one song !bump' : giftedCount + ' !bumps'} to use whenever you want.`);
      }
    });

    this.wss.registerHandler('song_request', payload => this.execute(payload.query, DEFAULT_REQUESTER_NAME, { maxDuration: 12000 }));
    this.wss.registerHandler('song_playback_started', this.handleSongPlaybackStarted);
    this.wss.registerHandler('song_playback_completed', this.handleSongPlaybackCompleted);
    this.wss.registerHandler('song_request_removed', this.handleSongPlaybackCompleted);
    this.wss.registerHandler('song_changed', this.handleSongChanged);

    this.jobs = new JobInterface();
    this.jobs.listen(Queues.SONG_REQUEST_COMPLETE, this.handleSongRequestComplete);
    this.jobs.listen(Queues.SONG_REQUEST_ERROR, this.handleSongRequestError);
  }

  private handleSongPlaybackStarted = async (payload: WebSocketMessage<'song_playback_started'>) => {
    if (!payload.songRequestId) return;
    await db.updateTable('songRequests')
      .set({ status: 'playing' })
      .where('id', '=', payload.songRequestId)
      .execute();
  }

  private handleSongPlaybackCompleted = async (payload: WebSocketMessage<'song_playback_completed' | 'song_request_removed'>) => {
    if (!payload.songRequestId) return;
    const nextStatus = payload.type === 'song_playback_completed' ? 'fulfilled' : 'cancelled';
    this.log('Set song request', payload.songRequestId, nextStatus);
    // Update song request in the database
    await db.updateTable('songRequests')
      .set({ status: nextStatus, fulfilledAt: new Date().toUTCString() })
      .where('id', '=', payload.songRequestId)
      .execute();
  };

  private log = createLogger('SongRequestHandler');

  private async disambiguate(
    user: string,
    message: string,
    helpString: string,
  ) {
    const songRequests = await queries.songRequestsByUser(user);
    let songRequest: typeof songRequests[0] | undefined = songRequests[0];
    let query = message;
    let isAmbiguous = false;
    if (songRequests.length > 1) {
      const reqNumberMatch = query.match(/^\s*#?\s*(\d+)\s*(.*)/);
      if (!reqNumberMatch || Number.isNaN(Number(reqNumberMatch[1]))) {
        const requestNames = songRequests
          .map((sr, i) => `${i + 1}: ${[sr.artist, sr.title].filter(s => s).join(' - ')}`)
          .join(', ');
        await this.client.sendTwitchMessage(`@${user} You have multiple songs on the wheel! ${helpString}`);
        await this.client.sendTwitchMessage(`@${user} ${requestNames}`)
        isAmbiguous = true;
      } else {
        songRequest = songRequests[Number(reqNumberMatch[1]) - 1];
        query = reqNumberMatch[2];
      }
    }

    return {
      songRequest,
      query,
      isAmbiguous,
    };
  }

  private async songRequestMaxDurationForUser(userName: string) {
    const viewer = await this.client.getViewer(userName);
    let maxDuration = SONG_REQUEST_MAX_DURATION;
    // if (viewer?.role.toUpperCase() === 'VIP') maxDuration = 60 * 10; // 10 mins for VIP
    if (viewer?.role === 'Moderator') maxDuration = 60 * 20; // 20 mins for mod
    if (viewer?.role === 'Broadcaster') maxDuration = 12000;
    return maxDuration;
  }

  private async songRequestMaxCountForUser(userName: string) {
    const viewer = await this.client.getViewer(userName);
    let limit = 1;
    if (viewer?.subscribed) limit = 2;
    if (viewer?.role.toUpperCase() === 'VIP') limit = 2;
    if (viewer?.role === 'Broadcaster') limit = 0;
    return limit;
  }

  private async songRequestMinViewsForUser(userName: string) {
    const viewer = await this.client.getViewer(userName);
    let minViews: number | undefined = 1000;
    if (viewer?.subscribed) minViews = 100;
    if (viewer?.role.toUpperCase() === 'VIP') minViews = undefined;
    if (viewer?.role === 'Moderator') minViews = undefined;
    if (viewer?.role === 'Broadcaster') minViews = undefined;
    return minViews;
  }

  private async isUserAdmin(userName: string) {
    const viewer = await this.client.getViewer(userName);
    return viewer?.role === 'Broadcaster' || viewer?.role === 'Moderator';
  }

  private async getExistingSongRequest(query: string, requesterName: string) {
    const sameQuery = await db.selectFrom('songRequests')
      .innerJoin('songs', 'songs.id', 'songRequests.songId')
      .select(['songRequests.id', 'songs.artist', 'songs.title'])
      .orderBy('songRequests.createdAt desc')
      .where('query', '=', query)
      .limit(1)
      .execute();
    if (sameQuery.length > 0) return sameQuery[0];
    if (['queue', 'queued song', 'song in queue'].includes(query)) {
      // find most recent request from the same requester
      const sameRequester = await db.selectFrom('songRequests')
        .innerJoin('songs', 'songs.id', 'songRequests.songId')
        .select(['songRequests.id', 'songs.artist', 'songs.title'])
        .orderBy('songRequests.createdAt desc')
        .where('requester', '=', requesterName)
        .limit(1)
        .execute();
      if (sameRequester.length > 0) return sameRequester[0];
    }
  }

  private async execute(
    query: string,
    requesterName: string,
    options: Partial<SongRequestOptions> = {},
    onSuccess?: (songTitle: string, numPreviousRequests: number, numPreviousRequestsBySameRequester: number) => void,
    onFailure?: (errorType: string) => void,
  ) {
    if (isURL(query)) {
      query = normalizeURL(query);
    } else {
      query = query.trim().toLowerCase();
    }

    let existingSongId: number | undefined | null;
    const priorSongRequest = (await db.selectFrom('songRequests')
      .leftJoin('songs', 'songId', 'songs.id')
      .leftJoin('downloads', 'downloadId', 'downloads.id')
      .select(['songId', 'stemsPath', 'artist', 'title', 'album', 'track', 'downloads.path as downloadPath', 'lyricsPath', 'isVideo'])
      .selectAll('songs')
      .where('query', '=', query)
      .execute())[0];
    if (priorSongRequest) {
      existingSongId = priorSongRequest.songId;
    }

    const songRequest = (await db.insertInto('songRequests').values({
      songId: existingSongId,
      query,
      priority: options.priority || 0,
      noShenanigans: Number(options.noShenanigans || 0),
      status: 'processing',
      requester: requesterName,
      twitchRewardId: options?.twitchRewardId,
      twitchRedemptionId: options?.twitchRedemptionId,
    }).returning('id as id').execute())[0];

    if (onSuccess) this.successCallbacks[songRequest.id] = onSuccess;
    if (onFailure) this.failureCallbacks[songRequest.id] = onFailure;

    if (existingSongId) {
      setImmediate(async () => {
        this.handleSongRequestComplete({
          id: songRequest.id,
          stemsPath: priorSongRequest.stemsPath!,
          downloadPath: priorSongRequest.downloadPath!,
          lyricsPath: priorSongRequest.lyricsPath!,
          isVideo: Boolean(priorSongRequest.isVideo),
          artist: priorSongRequest.artist!,
          title: priorSongRequest.title!,
          album: priorSongRequest.album!,
          track: priorSongRequest.track!,
          duration: priorSongRequest.duration!,
          requester: requesterName,
        });
      });
    } else {
      this.jobs.publish(Queues.SONG_REQUEST_CREATED, {
        id: songRequest.id,
        query,
        maxDuration: options.maxDuration,
        minViews: options.minViews,
        requester: requesterName,
      });
    }
    return songRequest.id;
  }

  private handleSongRequestComplete = async (payload: Payloads[typeof Queues.SONG_REQUEST_COMPLETE]) =>  {
    this.log('handleSongRequestComplete', payload);

    try {
      let song = (await db.selectFrom('songs')
        .select('id')
        .where('stemsPath', '=', payload.stemsPath)
        .execute())[0];
      if (song) {
        const existingSongRequest = await db.selectFrom('songRequests')
          .select('id')
          .where('songId', '=', song.id)
          .where('status', '=', 'ready')
          .execute();
        if (existingSongRequest.length) {
          // Cancel the new song request because one already exists
          await db.updateTable('songRequests')
            .set({ status: 'cancelled' })
            .where('id', '=', payload.id)
            .execute();
          throw new Error('REQUEST_ALREADY_EXISTS');
        }
      } else {
        const download = await db.insertInto('downloads').values({
          path: payload.downloadPath,
          lyricsPath: payload.lyricsPath,
          isVideo: Number(payload.isVideo),
          songRequestId: payload.id,
        }).returning('id as id').execute();
        song = (await db.insertInto('songs').values({
          artist: payload.artist,
          title: payload.title,
          album: payload.album,
          track: payload.track,
          duration: payload.duration,
          stemsPath: payload.stemsPath,
          downloadId: download[0].id,
        }).returning('id as id').execute())[0];
      }
      await db.updateTable('songRequests')
        .set({ status: 'ready', songId: song.id })
        .where('id', '=', payload.id)
        .execute();

      const previousRequests = await db
        .selectFrom('songRequests')
        .select([
          db.fn.countAll<number>().as('total'),
          db.fn.count<number>('id').filterWhere(sql`lower(requester)`, '=', payload.requester).as('sameRequester')
        ])
        .where('songId', '=', song.id)
        .where('status', '=', 'fulfilled')
        .execute();

      this.wss.broadcast({ type: 'song_request_added', songRequestId: payload.id });

      this.successCallbacks[payload.id]?.(
        [payload.artist, payload.title].filter(s => s).join(' - '),
        previousRequests[0].total,
        previousRequests[0].sameRequester,
      );
    } catch (e) {
      return this.handleSongRequestError({
        errorMessage: e instanceof Error ? e.message : (e as string),
        id: payload.id,
      });
    }
  };

  private handleSongRequestError = async (payload: Payloads[typeof Queues.SONG_REQUEST_ERROR]) => {
    await db.updateTable('songRequests')
      .set({ status: 'cancelled' })
      .where('id', '=', payload.id)
      .execute();
    this.failureCallbacks[payload.id]?.(payload.errorMessage);
  };

  private prepareSongRequestQuery(query: string) {
    // If message has a URL, use only the URL
    const url = query.match(/https?:\/\/\S+/)?.[0];

    // Strip accidental inclusions on the original message if using that
    let userInput = url || query.trim().replace(/^\!(sr|ssr|request|songrequest|rs)\s+/i, '');
    // Remove brackets that users included (like !sr <foo bar> instead of !sr foo bar)
    userInput = userInput.replace(/^</, '').replace(/>$/, '');
    if (!url && !userInput.includes('-')) {
      // strip "song by artist" to "song artist" to not confuse spotify search
      userInput = userInput.replace(/ by /i, ' ');
    }

    if (userInput.length <= SongRequestModule.MINIMUM_QUERY_LENGTH) {
      throw new Error('MINIMUM_QUERY_LENGTH');
    }
    return userInput;
  }

  private async prepareUserSongRequest(
    query: string,
    fromUsername: string,
    perUserLimit?: number,
  ) {
    // Check if user already has the maximum ongoing song requests before processing
    const existingRequestCount = await queries.numOpenRequestsByUser(fromUsername);
    if (perUserLimit && Number(existingRequestCount[0].count) >= perUserLimit) {
      let message = `@${fromUsername} You have the maximum number of ongoing song requests (${perUserLimit}), `;
      if (perUserLimit === 1) {
        message += 'please wait until your song has played before requesting another! (Subs get 2 at a time!)';
      } else {
        message += `please wait until one of your songs has played before requesting another!`;
      }
      message += ` [Use !replace to change your song]`;
      await this.client.sendTwitchMessage(message);
      throw new Error('TOO_MANY_REQUESTS');
    }

    try {
      const userInput = this.prepareSongRequestQuery(query);
      return userInput;
    } catch (err) {
      await this.client.doAction('!how');
      throw err;
    }
  }

  private async handleUserSongRequest(
    query: string,
    requesterName: string,
    options: Partial<SongRequestOptions> = {},
  ) {
    let hasResponded = false;
    setTimeout(async () => {
      if (!hasResponded) {
        await this.client.sendTwitchMessage(`Working on it, @${requesterName}! Give me a moment to download that song.`);
      }
    }, 500);

    options.maxDuration ||= await this.songRequestMaxDurationForUser(requesterName);
    options.minViews ||= await this.songRequestMinViewsForUser(requesterName);
    const songRequestId = await this.execute(
      query.trim(),
      requesterName,
      options,
      async (songTitle: string, numPreviousRequests: number, numPreviousRequestsBySameRequester: number) => {
        if (options?.songRequestToReplaceId) {
          const oldSongRequest = await db.updateTable('songRequests')
            .where('id', '=', options.songRequestToReplaceId)
            .set('status', 'cancelled')
            .returning(['effectiveCreatedAt'])
            .execute();
          await db.updateTable('songRequests')
            .where('id', '=', songRequestId)
            .set('effectiveCreatedAt', oldSongRequest[0].effectiveCreatedAt)
            .execute();
          await this.client.sendTwitchMessage(`@${requesterName} Your request has been replaced with ${songTitle}!`);
        } else {
          let message = `@${requesterName} ${songTitle} was added to the wheel!`;
          // if (numPreviousRequests === 0) {
          //   message += ` It's never been requested before! OOOO`;
          // }
          // If someone removed their request and re-requested (instead of using !edit),
          // set the effectiveCreatedAt to the time of the original request
          if (this.removedSongRequests[requesterName]) {
            await db.updateTable('songRequests')
              .where('id', '=', songRequestId)
              .set('effectiveCreatedAt', this.removedSongRequests[requesterName])
              .execute();
            delete this.removedSongRequests[requesterName];
          }
          await this.client.sendTwitchMessage(message);
        }
        hasResponded = true;
      },
      async (errorMessage) => {
        let message = 'There was an error adding your song request!';
        if (errorMessage === 'VIDEO_UNAVAILABLE') message = 'That video is not available.';
        if (errorMessage === 'UNSUPPORTED_DOMAIN') message = 'Only Spotify or YouTube links are supported.';
        if (errorMessage === 'DOWNLOAD_FAILED') message = 'I wasn\'t able to download that link.';
        if (errorMessage === 'NO_PLAYLISTS') message = 'Playlists aren\'t supported, request a single song instead.';
        if (errorMessage === 'TOO_LONG') message = `That song is too long! The limit is ${formatTime(options.maxDuration)}.`;
        if (errorMessage === 'AGE_RESTRICTED') message = 'The song downloader doesn\'t currently support age-restricted videos.';
        if (errorMessage === 'MINIMUM_VIEWS') message = `Videos with under ${options.minViews} views are not allowed.`;
        if (errorMessage === 'REQUEST_ALREADY_EXISTS') message = 'That song is already in the song request queue.';
        await this.client.sendTwitchMessage(`@${requesterName} ${message}`);
        hasResponded = true;
        // TODO: rethrow to allow to catch for refund
        // throw e;
      }
    );
  }

  private handleSongChanged = async (payload: WebSocketMessage<'song_changed'>) => {
    // Notify user when their song request is starting
    if (payload.song.requester && payload.song.status === 'ready') {
      await this.client.sendTwitchMessage(`@${payload.song.requester} ${payload.song.artist} - ${payload.song.title} is starting!`);
    }
  };
}
