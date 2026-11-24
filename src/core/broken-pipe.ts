/**
 * `watch prompt | head`、`watch --help | head` 这类管道：下游读够就关掉 stdout，
 * Node 会把后续写入变成 `EPIPE` 的 `'error'` 事件；没人监听时打印整段堆栈并以 1 退出。
 *
 * 这与命令本身失败无关，只是下游主动停止读取。终端产品里按 Unix 惯例安静收尾即可，
 * 不能让用户看到 `Error: write EPIPE`。非 EPIPE 的流错误仍然原样抛出，不能借机吞掉。
 */
export type BrokenPipeStream = Pick<NodeJS.EventEmitter, 'on'>;

export function exitOnBrokenPipe(
  streams: readonly BrokenPipeStream[],
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  for (const stream of streams) {
    stream.on('error', (error: NodeJS.ErrnoException) => {
      if (error?.code === 'EPIPE') {
        exit(0);
        return;
      }
      throw error;
    });
  }
}
