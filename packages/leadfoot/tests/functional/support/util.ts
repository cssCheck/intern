import { sep } from 'path';

import Server from '../../../src/Server';
import Session from '../../../src/Session';
import { LeadfootURL } from '../../../src/interfaces';
import { Remote } from '@theintern/core/dist/lib/executors/Node';
import ProxiedSession from '@theintern/core/dist/lib/ProxiedSession';

export * from '../../../src/lib/util';

export function createServer(config: LeadfootURL | string) {
  return new Server(config);
}

export function createServerFromRemote(remote: any) {
  if (remote.session && remote.session.server) {
    return new Server(remote.session.server.url);
  }

  throw new Error('Unsupported remote');
}

export function createSessionFromRemote(
  remote: Remote,
  SessionCtor: any = Session
): PromiseLike<Session> {
  const server = createServerFromRemote(remote);

  function fixGet(session: any) {
    const oldGet = session.get;
    session.get = function (this: Session, url: string) {
      if (!/^[A-Za-z][A-Za-z0-9+.-]+:/.test(url)) {
        url = convertPathToUrl(remote, url);
      }

      return oldGet.call(this, url);
    };
  }

  if (remote.session) {
    const session = new SessionCtor(
      remote.session.sessionId,
      server,
      remote.session.capabilities
    );
    fixGet(session);
    return (
      server['_fillCapabilities'](session)
        // Ensure the session has default timeouts
        .then(() => session.setFindTimeout(5000))
        .then(() => session.setExecuteAsyncTimeout(10000))
        .then(() => session.setPageLoadTimeout(30000))
        .then(() => session)
    );
  }

  throw new Error('Unsupported remote');
}

export function convertPathToUrl(remote: Remote, url: string) {
  const session: ProxiedSession = <ProxiedSession>remote.session;
  return `${session.baseUrl}${url}`;
}

export function pathRe(regex: string, flags?: string): RegExp {
  if (sep !== '/') {
    const winRegEx = regex.replace(/\//g, '\\\\');
    return new RegExp(winRegEx, flags);
  }
  return new RegExp(regex, flags);
}
