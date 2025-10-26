import { spawn } from 'child_process';
import { join } from 'path';

interface YouTubeDownloadOptions {
  maxDuration: number,
  minViews: number,
}

export function downloadFromYouTube(url: URL, outputPath: string, uuid: string, options: Partial<YouTubeDownloadOptions>) {
  if (url.pathname.startsWith('/channel/') || url.pathname.startsWith('/playlist')) {
    throw new Error('NO_PLAYLISTS');
  }

  return new Promise<string>((resolve, reject) => {
    const cmd = spawn('yt-dlp',
      [
        '--no-playlist',
        '--no-overwrites',
        ...(options.maxDuration ? ['--match-filter', `"duration<${options.maxDuration}"`] : []),
        ...(options.minViews ? ['--min-views', String(options.minViews)] : []),
         '--min-views', '1000',
         '--max-downloads', '1',
         '--cookies-from-browser', 'firefox',
        '--restrict-filenames',
        '--write-info-json',
        '--extractor-args', 'youtube:player-client=web_safari',
        '-f', '"bv*[height<=?720]"',
        '-S', '"filesize:50M"',
        '--output', `"${join(outputPath, `${uuid}.%%(ext)s`)}"`,
        `"${url.toString()}"`
      ],
      { shell: true }
    );
    cmd.stderr.on('data', msg => {
      const unavailableMatch = msg.toString().match(/\[youtube\] (.+): Video unavailable(.*)/);
      if (unavailableMatch) {
        console.warn(`YouTube video ${unavailableMatch[1]} not available: ${unavailableMatch[2]}`);
        reject(new Error('VIDEO_UNAVAILABLE'));
      } else if (msg.toString().match(/\[youtube:tab\] YouTube said: The playlist does not exist/)) {
        reject(new Error('VIDEO_UNAVAILABLE'));
      } else if (msg.toString().match('Sign in to confirm your age')) {
        reject(new Error('AGE_RESTRICTED'));
      } else {
        console.warn('yt-dlp.exe stderr:', msg.toString());
      }
    });
    let buf = '';
    cmd.stdout.on('data', msg => {
      if (msg.toString().match(/\[download\] (.+) does not pass filter \(duration/)) {
        return reject(new Error('TOO_LONG'));
      } else if (msg.toString().match('because it has not reached minimum view count')) {
        return reject(new Error('MINIMUM_VIEWS'));
      }
      buf += msg.toString();
    });
    cmd.on('close', () => {
      const dupeMatch = buf.match(/\[download\] (.+) has already been downloaded/);
      const mergeMatch = buf.match(/\[Merger\] Merging formats into "(.+)"/);
      const downloadMatch = buf.match(/\[download\] Destination: (.+)/);
      const match = dupeMatch || mergeMatch || downloadMatch;
      if (match) {
        return resolve(match[1]);
      }
      console.log('yt-dlp closed without a downloadedSong');
      reject(new Error('DOWNLOAD_FAILED'));
    });
    cmd.on('error', (err) => {
      console.error('Song download error', err);
      reject(new Error('DOWNLOAD_FAILED'));
    });
  });
}
