export {};

import type { TranslationConfig, TranslationSettingsData, TranslationSettingsSnapshot, TranslationIPCResult, TranslationBatch, TranslationBatchPreview, TranslationBatchResult } from "../lib/desktopTranslation";

declare global {
  interface DesktopBookReference {
    token: string;
    sourceKey: string;
    name: string;
    extension: string;
    size: number;
  }

  interface DesktopConversionProgress {
    jobId: string;
    percent: number;
    message: string;
  }

  interface DesktopToolchainStatus {
    available: boolean;
    source: string | null;
    version: string | null;
    message: string;
  }

  type DesktopPreparedBook =
    | {
        ok: true;
        name: string;
        sourceExtension: string;
        mimeType: string;
        bytes: ArrayBuffer;
        converted: boolean;
      }
    | {
        ok: false;
        code?: string;
        error: string;
      };

  interface ReadTaylorDesktopAPI {
    pickBooks(): Promise<DesktopBookReference[]>;
    prepareBook(token: string, jobId: string): Promise<DesktopPreparedBook>;
    getToolchain(): Promise<DesktopToolchainStatus>;
    openCalibreHelp(): Promise<boolean>;
    getTranslationSettings(): Promise<TranslationIPCResult<TranslationSettingsData>>;
    saveTranslationSettings(config: TranslationConfig): Promise<TranslationIPCResult<TranslationSettingsSnapshot>>;
    editTranslationKey(config: TranslationConfig): Promise<TranslationIPCResult<TranslationSettingsSnapshot & { keySaved: boolean }>>;
    clearTranslationSettings(): Promise<TranslationIPCResult<TranslationSettingsSnapshot>>;
    previewTranslationBatch(batch: TranslationBatch): Promise<TranslationIPCResult<TranslationBatchPreview>>;
    sendTranslationBatch(previewId: string): Promise<TranslationIPCResult<TranslationBatchResult>>;
    onConversionProgress(
      callback: (update: DesktopConversionProgress) => void
    ): () => void;
    onOpenBooks(callback: (books: DesktopBookReference[]) => void): () => void;
  }

  interface Window {
    readTaylorDesktop?: ReadTaylorDesktopAPI;
  }
}
