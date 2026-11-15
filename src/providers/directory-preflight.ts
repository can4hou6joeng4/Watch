import { describePathReadFailureReason } from '../core/read-text.js';
import { PreflightBlockedError } from './adapter.js';
import type { ProviderAdapter, WriteLimit } from './adapter.js';

/**
 * 由本家目录解析函数提供判据，让预检与 doctor 共用原因、错误码和下一步。
 * 每次调用都重新只读检查；目录尚未建立的语义仍由解析函数决定。
 * 通过只表示没有发现这类目录故障，不证明写权限、锁状态或叶子目录可用。
 */
export function directoryWriteChecks(
  providerId: string,
  directory: () => string,
): Required<Pick<ProviderAdapter, 'preflight' | 'writeLimit'>> {
  const writeLimit = async (): Promise<WriteLimit | null> => {
    try {
      directory();
      return null;
    } catch (error) {
      return {
        code: `${providerId}_data_dir_unusable`,
        reason: describePathReadFailureReason(error),
        hint: '未写入任何内容；先按上述原因恢复目录或修正对应的目录变量后重试。',
        kind: 'fault',
      };
    }
  };
  return {
    writeLimit,
    async preflight() {
      const limit = await writeLimit();
      if (limit) {
        throw new PreflightBlockedError({ code: limit.code, message: limit.reason, hint: limit.hint });
      }
    },
  };
}
