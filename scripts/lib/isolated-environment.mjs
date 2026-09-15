import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Do not inherit agent credentials, alternate config roots, or proxy settings.
export async function createIsolatedEnvironment(prefix = 'watch-test-') {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  const home = path.join(root, 'home');
  const temp = path.join(root, 'tmp');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(temp, { recursive: true, mode: 0o700 });
  const env = {};
  for (const key of [
    'PATH',
    'TERM',
    'COLORTERM',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    TMPDIR: temp,
    TEMP: temp,
    TMP: temp,
    WATCH_DB: path.join(root, 'watch.db'),
    WATCH_OPENCODE_DB: path.join(root, 'opencode.db'),
    npm_config_cache: path.join(root, 'npm-cache'),
    npm_config_offline: 'true',
    LANG: 'en_US.UTF-8',
    NO_COLOR: '1',
  });
  return { root, home, env, cleanup: () => rm(root, { recursive: true, force: true }) };
}
