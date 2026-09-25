import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface KakureConfig {
  network: string; // e.g. "http://127.0.0.1:8899"
  coordinatorUrl: string; // e.g. "http://127.0.0.1:8788"
  indexerUrl: string; // e.g. "http://127.0.0.1:8787"
  programId: string; // kakure_pool program id, base58
  artifactsDir?: string;
  keystorePath?: string;
}

export const DEFAULT_CONFIG: KakureConfig = {
  network: "http://127.0.0.1:8899",
  coordinatorUrl: "http://127.0.0.1:8788",
  indexerUrl: "http://127.0.0.1:8787",
  programId: "11111111111111111111111111111111",
};

export function defaultConfigDir(): string {
  return process.env.KAKURE_CONFIG_DIR ?? join(homedir(), ".kakure");
}

export function defaultConfigPath(dir: string = defaultConfigDir()): string {
  return join(dir, "config.json");
}

export function defaultKeystorePath(dir: string = defaultConfigDir()): string {
  return join(dir, "keystore.json");
}

export async function loadConfig(path: string = defaultConfigPath()): Promise<KakureConfig> {
  try {
    const raw = await readFile(path, "utf-8");
    return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<KakureConfig>) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_CONFIG };
    throw err;
  }
}

export async function saveConfig(config: KakureConfig, path: string = defaultConfigPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(config, null, 2), { mode: 0o600 });
}
