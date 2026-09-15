export function createIsolatedEnvironment(prefix?: string): Promise<{
  root: string;
  home: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
}>;
