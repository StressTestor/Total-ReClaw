export interface VaultConfig {
  embedding: {
    provider: "auto" | "openai" | "gemini" | "voyage" | "local";
    apiKey?: string;
    model?: string;
  };
  autoCapture: boolean;
  autoRecall: boolean;
  recallLimit: number;
  captureMaxChars: number;
  consolidation: {
    enabled: boolean;
    intervalMinutes: number;
  };
}

const DEFAULTS: VaultConfig = {
  embedding: { provider: "auto" },
  autoCapture: true,
  autoRecall: true,
  recallLimit: 5,
  captureMaxChars: 2000,
  consolidation: { enabled: true, intervalMinutes: 360 },
};

export function resolveConfig(raw?: Record<string, unknown>): VaultConfig {
  if (!raw) return { ...DEFAULTS };
  const cfg = raw as Partial<VaultConfig>;
  return {
    embedding: {
      provider: cfg.embedding?.provider ?? DEFAULTS.embedding.provider,
      apiKey: cfg.embedding?.apiKey,
      model: cfg.embedding?.model,
    },
    autoCapture: cfg.autoCapture ?? DEFAULTS.autoCapture,
    autoRecall: cfg.autoRecall ?? DEFAULTS.autoRecall,
    recallLimit: cfg.recallLimit ?? DEFAULTS.recallLimit,
    captureMaxChars: cfg.captureMaxChars ?? DEFAULTS.captureMaxChars,
    consolidation: {
      enabled: cfg.consolidation?.enabled ?? DEFAULTS.consolidation.enabled,
      intervalMinutes: cfg.consolidation?.intervalMinutes ?? DEFAULTS.consolidation.intervalMinutes,
    },
  };
}
