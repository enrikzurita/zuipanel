export type ContentType = 'live' | 'movie' | 'series';

/** Opciones de un perfil de transcodificación (columna transcode_profiles.options). */
export interface TranscodeOptions {
  /** copy = sin recodificar; libx264 = CPU; h264_nvenc / hevc_nvenc = GPU NVIDIA */
  videoCodec?: 'copy' | 'libx264' | 'libx265' | 'h264_nvenc' | 'hevc_nvenc';
  /** Preset del encoder: veryfast/fast… para x264, p1…p7 para NVENC */
  preset?: string;
  /** Bitrate de vídeo, p. ej. "4000k" */
  videoBitrate?: string;
  /** Alto de salida en píxeles; el ancho mantiene la proporción */
  height?: number;
  /** Fotogramas por segundo de salida (opcional) */
  fps?: number;
  audioCodec?: 'copy' | 'aac';
  audioBitrate?: string;
  /** Duración de cada segmento HLS en segundos */
  hlsTime?: number;
  /** Opciones extra de FFmpeg añadidas antes de la salida */
  extraArgs?: string[];
}

/** Lo que el panel envía a cada agente para que sepa qué canales gestionar. */
export interface AgentStreamConfig {
  id: number;
  name: string;
  sources: string[];
  onDemand: boolean;
  userAgent: string | null;
  transcode: TranscodeOptions | null;
}

export interface AgentConfigResponse {
  serverId: number;
  streams: AgentStreamConfig[];
}

export interface AgentStreamStatus {
  id: number;
  running: boolean;
  sourceIndex: number;
  uptimeSec: number;
  restarts: number;
  lastError: string | null;
  video?: string;
  audio?: string;
}

export interface AgentHeartbeat {
  serverId: number;
  clients: number;
  load: number[];
  streams: AgentStreamStatus[];
}
