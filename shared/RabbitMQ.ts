import * as amqp from 'amqplib';

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://drums:drums@localhost';

export type Payloads = {
  'song_request_created': {
    id: number,
    query: string,
    maxDuration?: number,
    minViews?: number,
    ignoreDuplicates?: boolean,
  },
  'song_request_downloaded': {
    id: number,
    path: string,
    ignoreDuplicates?: boolean,
    artist: string,
    title: string,
    album: string,
    track: number,
    duration: number,
  },
  'song_request_complete': {
    id: number,
    downloadPath: string,
    stemsPath: string,
    lyricsPath?: string,
    isVideo?: boolean,
    artist: string,
    title: string,
    album: string,
    track: number,
    duration: number,
  },
  'song_request_error': {
    id: number,
    error: Error,
  },
};

export const Queues = {
  SONG_REQUEST_CREATED: 'song_request_created',
  SONG_REQUEST_DOWNLOADED: 'song_request_downloaded',
  SONG_REQUEST_COMPLETE: 'song_request_complete',
  SONG_REQUEST_ERROR: 'song_request_error',
} as const;

export class JobInterface {
  private connection?: amqp.Connection;
  private channel?: amqp.Channel;

  async connect() {
    this.connection = await amqp.connect(RABBITMQ_URL);
    this.channel = await this.connection.createChannel();
    
    for (let queueName of Object.values(Queues)) {
      await this.channel.assertQueue(queueName, { durable: true });
    }
  }

  async close() {
    await this.channel?.close();
    await this.connection?.close();
  }

  async listen<Q extends keyof Payloads>(queueName: Q, callback: (result: Payloads[Q]) => void) {
    if (!this.channel) await this.connect();
    await this.channel!.consume(queueName, (msg) => {
      if (!msg) return;
      console.info(`Handling message on queue "${queueName}"`);
      const result: Payloads[Q] = JSON.parse(msg.content.toString());
      try {
        callback(result);
      } catch (error) {
        if (queueName === Queues.SONG_REQUEST_ERROR) {
          // don't end up in a loop if we error while handling an error message!
          return;
        }
        this.channel?.sendToQueue(Queues.SONG_REQUEST_ERROR, Buffer.from(JSON.stringify({
          id: result.id,
          error
        })), { persistent: true });
      }
      this.channel?.ack(msg);
    });
    console.info(`Listening for messages in queue "${queueName}"`);
  }

  async publish<Q extends keyof Payloads>(queueName: Q, payload: Payloads[Q]) {
    if (!this.channel) await this.connect();
    const id = await this.channel!.sendToQueue(queueName, Buffer.from(JSON.stringify(payload)));
    console.info(`Published message ID ${id} to queue "${queueName}"`);
    return id;
  }
}