import { watchFile, unwatchFile } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { createCompositeHandle, request } from '@theintern/common';
import Tunnel, { ChildExecutor, TunnelProperties } from './Tunnel';
import { JobState, NormalizedEnvironment } from './types';
import { fileExists, on } from './lib/util';

const cbtVersion = '1.2.2';
const baseAssetUrl =
  'https://github.com/crossbrowsertesting/cbt-tunnel-nodejs/releases/download';

/**
 * A CrossBrowserTesting tunnel.
 *
 * This tunnel requires some non-standard configuration options (vs the other
 * tunnels):
 *
 * 1. The capabilities must include the username, API key, browser_api_name, and
 *    os_api_name properties
 * 2. The Intern proxyUrl must use 'local' instead of 'localhost'
 *
 * An Intern config using this tunnel might be look like:
 *
 * ```js
 * {
 *     "serverUrl": "http://local:9000",
 *     "tunnel": "cbt",
 *     "environments": [
 *         {
 *             "browserName": "chrome",
 *             "os_api_name": "Win10",
 *             "browser_api_name": "Chrome52"
 *         }
 *     ],
 * 	   // Other Intern config options...
 * }
 * ```
 *
 * The username and accessKey properties will be initialized using CBT_USERNAME
 * and CBT_APIKEY.
 */
export default class CrossBrowserTestingTunnel extends Tunnel
  implements CrossBrowserTestingProperties {
  /** The version of the cbt_tunnels package to use */
  cbtVersion!: string;

  constructor(options?: Partial<CrossBrowserTestingProperties>) {
    super(
      Object.assign(
        {
          accessKey: process.env.CBT_APIKEY,
          cbtVersion,
          environmentUrl:
            'https://crossbrowsertesting.com/api/v3/selenium/browsers?format=json',
          hostname: 'hub.crossbrowsertesting.com',
          port: '80',
          username: process.env.CBT_USERNAME,
          directory: join(__dirname, 'cbt_tunnel')
        },
        options || {}
      )
    );
  }

  get artifact() {
    return this.executable;
  }

  get auth() {
    return `${this.username || ''}:${this.accessKey || ''}`;
  }

  get executable() {
    const extension = process.platform === 'win32' ? '.exe' : '';
    return join(
      this.directory,
      `cbt_tunnel-${getCbtPlatform()}-${process.arch}${extension}`
    );
  }

  get extraCapabilities() {
    return {
      username: this.username,
      password: this.accessKey
    };
  }

  get isDownloaded() {
    return fileExists(this.executable);
  }

  download(forceDownload = false): Promise<void> {
    if (!forceDownload && this.isDownloaded) {
      return Promise.resolve();
    }

    const base = basename(this.artifact, '.exe');
    const url = `${baseAssetUrl}/v${cbtVersion}/${base}.zip`;

    return this._downloadFile(url, this.proxy);
  }

  protected _makeArgs(readyFile: string): string[] {
    if (!this.username || !this.accessKey) {
      throw new Error(
        'CrossBrowserTestingTunnel requires a username and access key'
      );
    }

    return [
      '--authkey',
      this.accessKey,
      '--username',
      this.username,
      '--ready',
      readyFile
    ];
  }

  sendJobState(jobId: string, data: JobState): Promise<void> {
    const payload = JSON.stringify({
      action: 'set_score',
      score: data.status || data.success ? 'pass' : 'fail'
    });

    const url = `https://crossbrowsertesting.com/api/v3/selenium/${jobId}`;
    return request(url, {
      method: 'put',
      data: payload,
      headers: {
        'Content-Length': String(Buffer.byteLength(payload, 'utf8')),
        'Content-Type': 'application/json'
      },
      username: this.username,
      password: this.accessKey,
      proxy: this.proxy
    }).then<void>(response => {
      if (response.status !== 200) {
        return response.text().then(text => {
          if (text) {
            const data = JSON.parse(text);

            if (data.status) {
              throw new Error(`Could not save test status (${data.message})`);
            }

            throw new Error(`Server reported ${response.status} with: ${text}`);
          } else {
            throw new Error(
              `Server reported ${response.status} with no other data.`
            );
          }
        });
      }
    });
  }

  protected _start(executor: ChildExecutor): Promise<any> {
    const readyFile = join(tmpdir(), 'CrossBrowserTesting-' + Date.now());

    return this._makeChild((child, resolve, reject) => {
      let stdout: string[] | null = [];

      // Polling API is used because we are only watching for one file, so
      // efficiency is not a big deal, and the `fs.watch` API has extra
      // restrictions which are best avoided
      watchFile(readyFile, { persistent: false, interval: 1007 }, function (
        current,
        previous
      ) {
        if (Number(current.mtime) === Number(previous.mtime)) {
          // readyFile hasn't been modified, so ignore the event
          return;
        }

        unwatchFile(readyFile);
        readHandle.destroy();
        exitHandle.destroy();
        stdout = null;
        resolve();
      });

      // The cbt tunnel outputs its startup error messages on stdout.
      // Capture any data on stdout and display it if the process exits
      // early.
      const readHandle = on(child.stdout!, 'data', (data: any) => {
        stdout!.push(String(data));
      });
      const exitHandle = on(child, 'exit', function () {
        process.stderr.write(stdout!.join(''));
      });

      this._handle = createCompositeHandle(readHandle, exitHandle);

      executor(child, resolve, reject);
    }, readyFile);
  }

  /**
   * Attempt to normalize a TestingBot described environment with the standard
   * Selenium capabilities
   *
   * TestingBot returns a list of environments that looks like:
   *
   * {
   *     "selenium_name": "Chrome36",
   *     "name": "googlechrome",
   *     "platform": "CAPITAN",
   *     "version":"36"
   * }
   *
   * @param environment a TestingBot environment descriptor
   * @returns a normalized descriptor
   */
  protected _normalizeEnvironment(environment: any): NormalizedEnvironment {
    const platform = environment.api_name;

    return environment.browsers.map(function (browser: any) {
      const browserName = browser.type.toLowerCase();

      return {
        platform,
        browserName,
        version: browser.version,

        descriptor: environment,

        intern: {
          browserName,
          version: browser.version,
          browser_api_name: browser.api_name,
          os_api_name: platform
        }
      };
    });
  }
}

/**
 * Options specific to the CrossBrowserTestingTunnel
 */
export interface CrossBrowserTestingProperties extends TunnelProperties {
  /** [[CrossBrowserTestingTunnel.CrossBrowserTestingTunnel.cbtVersion|More info]] */
  cbtVersion: string;
}

function getCbtPlatform() {
  const { platform } = process;
  switch (platform) {
    case 'win32':
      return 'win';
    case 'darwin':
      return 'macos';
    default:
      return platform;
  }
}
