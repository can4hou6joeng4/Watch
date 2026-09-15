export type CodexImportStatus = "prepared" | "imported" | "uncertain";

export type CodexImportResult = {
  ok: boolean;
  planId: string;
  status: CodexImportStatus;
  canConfirm: boolean;
  desktop: string;
  warnings: string[];
  targetLockPath?: string;
  plan: {
    source: {
      provider: "claude";
      sessionId: string;
      cwd: string;
      filePath: string;
    };
    cliVersion: string;
    codexHome: string;
    target?: { path: string };
    desktopProject?: {
      name: string;
      legacyProjectId: string;
      nativeProjectId: string;
      rootPaths: string[];
    };
  };
  outcome?: {
    target?: {
      provider: "codex";
      sessionId: string;
      cwd: string;
      filePath: string;
    };
  } | null;
};

export type CodexImportView =
  | { status: "idle" }
  | { status: "preparing"; sourceId: string; cwd: string }
  | { status: "prepared"; result: CodexImportResult }
  | { status: "confirming"; result: CodexImportResult }
  | { status: "checking"; result: CodexImportResult }
  | { status: "imported"; result: CodexImportResult; opening: boolean; opened?: boolean; openError?: string }
  | { status: "uncertain"; result: CodexImportResult }
  | { status: "error"; message: string; result?: CodexImportResult };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Codex 导入返回了无效数据");
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Codex 导入缺少 ${field}`);
  return value;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Codex 导入缺少 ${field}`);
  }
  return value;
}

function isUuid(value: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
}

export function parseCodexImportResult(value: unknown): CodexImportResult {
  const root = record(value);
  if (root.ok === false && typeof root.error === "string" && root.status == null) throw new Error(root.error);

  const status = root.status;
  if (status !== "prepared" && status !== "imported" && status !== "uncertain") {
    throw new Error("Codex 导入返回了未知状态");
  }
  if (root.ok !== (status !== "uncertain")) throw new Error("Codex 导入的结果状态不一致");
  const planId = text(root.planId, "planId");
  if (!/^[a-f0-9]{64}$/.test(planId)) throw new Error("Codex 导入返回了无效计划 ID");

  const planValue = record(root.plan);
  const sourceValue = record(planValue.source);
  const source = {
    provider: text(sourceValue.provider, "source.provider"),
    sessionId: text(sourceValue.sessionId, "source.sessionId"),
    cwd: text(sourceValue.cwd, "source.cwd"),
    filePath: text(sourceValue.filePath, "source.filePath"),
  };
  if (source.provider !== "claude") throw new Error("Codex 官方导入仅接受 Claude Code 来源");
  if (!isUuid(source.sessionId)) throw new Error("Codex 导入返回了无效来源会话 ID");

  const targetValue = planValue.target == null ? undefined : record(planValue.target);
  const desktopValue = planValue.desktopProject == null ? undefined : record(planValue.desktopProject);
  const desktopProject = desktopValue
    ? {
        name: text(desktopValue.name, "desktopProject.name"),
        legacyProjectId: text(desktopValue.legacyProjectId, "desktopProject.legacyProjectId"),
        nativeProjectId: text(desktopValue.nativeProjectId, "desktopProject.nativeProjectId"),
        rootPaths: stringList(desktopValue.rootPaths, "desktopProject.rootPaths"),
      }
    : undefined;
  if (!desktopProject) throw new Error("Codex 导入计划未绑定 Desktop 项目");
  if (!desktopProject.rootPaths.includes(source.cwd)) throw new Error("Codex Desktop 项目未绑定来源目录");

  const outcomeValue = root.outcome == null ? undefined : record(root.outcome);
  const outcomeTargetValue = outcomeValue?.target == null ? undefined : record(outcomeValue.target);
  const outcomeTarget = outcomeTargetValue
    ? {
        provider: text(outcomeTargetValue.provider, "outcome.target.provider"),
        sessionId: text(outcomeTargetValue.sessionId, "outcome.target.sessionId"),
        cwd: text(outcomeTargetValue.cwd, "outcome.target.cwd"),
        filePath: optionalText(outcomeTargetValue.filePath) ?? "",
      }
    : undefined;
  if (outcomeTarget && outcomeTarget.provider !== "codex") throw new Error("Codex 导入返回了错误的目标 provider");
  if (outcomeTarget && (!isUuid(outcomeTarget.sessionId) || outcomeTarget.cwd !== source.cwd)) {
    throw new Error("Codex 导入目标与来源计划不一致");
  }
  if (status === "imported" && !outcomeTarget) throw new Error("Codex 导入成功但没有目标线程");

  return {
    ok: root.ok === true,
    planId,
    status,
    canConfirm: root.canConfirm === true,
    desktop: text(root.desktop, "desktop"),
    warnings: stringList(root.warnings, "warnings"),
    targetLockPath: optionalText(root.targetLockPath),
    plan: {
      source: { ...source, provider: "claude" },
      cliVersion: text(planValue.cliVersion, "cliVersion"),
      codexHome: text(planValue.codexHome, "codexHome"),
      target: targetValue ? { path: text(targetValue.path, "target.path") } : undefined,
      desktopProject,
    },
    outcome: outcomeValue
      ? { target: outcomeTarget ? { ...outcomeTarget, provider: "codex" } : undefined }
      : root.outcome === null
        ? null
        : undefined,
  };
}

export function viewForCodexImportResult(result: CodexImportResult): CodexImportView {
  if (result.status === "prepared") {
    if (!result.canConfirm) throw new Error("Codex 导入计划不可确认，请重新预览");
    return { status: "prepared", result };
  }
  if (result.status === "imported") return { status: "imported", result, opening: false };
  return { status: "uncertain", result };
}

export function importedCodexThreadId(result: CodexImportResult): string | null {
  return result.status === "imported" ? (result.outcome?.target?.sessionId ?? null) : null;
}

export function beginCodexOpen(result: CodexImportResult): CodexImportView {
  if (!importedCodexThreadId(result)) throw new Error("Codex 导入尚未生成可打开的目标线程");
  return { status: "imported", result, opening: true };
}

export function completeCodexOpen(result: CodexImportResult): CodexImportView {
  if (!importedCodexThreadId(result)) throw new Error("Codex 导入尚未生成可打开的目标线程");
  return { status: "imported", result, opening: false, opened: true };
}

export function failCodexOpen(result: CodexImportResult, error: unknown): CodexImportView {
  if (!importedCodexThreadId(result)) throw new Error("Codex 导入尚未生成可打开的目标线程");
  return {
    status: "imported",
    result,
    opening: false,
    openError: error instanceof Error ? error.message : String(error),
  };
}

export function assertSameCodexImportPlan(expected: CodexImportResult, next: CodexImportResult): void {
  if (
    next.planId !== expected.planId ||
    next.plan.source.sessionId !== expected.plan.source.sessionId ||
    next.plan.source.cwd !== expected.plan.source.cwd ||
    next.plan.codexHome !== expected.plan.codexHome
  ) {
    throw new Error("Codex 导入状态与已确认的计划不一致");
  }
}
