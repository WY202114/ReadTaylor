export function isDesktopApp(): boolean {
  return Boolean(window.readTaylorDesktop);
}

export async function pickDesktopBooks(): Promise<DesktopBookReference[]> {
  return window.readTaylorDesktop?.pickBooks() ?? [];
}

export async function prepareDesktopBook(
  reference: DesktopBookReference,
  jobId: string
): Promise<{ file: File; converted: boolean; sourceExtension: string }> {
  const result = await window.readTaylorDesktop?.prepareBook(reference.token, jobId);
  if (!result) throw new Error("桌面导入服务不可用，请重新启动 ReadTaylor。");
  if (!result.ok) {
    const error = new Error(result.error) as Error & { code?: string };
    error.code = result.code;
    throw error;
  }
  const bytes = new Uint8Array(result.bytes).slice();
  return {
    file: new File([bytes.buffer], result.name, { type: result.mimeType }),
    converted: result.converted,
    sourceExtension: result.sourceExtension,
  };
}

export function desktopJobId(): string {
  return `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
