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
  /** pull = el nodo lee las fuentes; push = la cámara/OBS emite al nodo por RTMP */
  input?: 'pull' | 'push';
  streamKey?: string | null;
  /** Grabar cada emisión como VOD (solo push) */
  record?: boolean;
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
  input?: 'pull' | 'push';
  /** Para canales push: hay alguien emitiendo ahora mismo */
  signal?: boolean;
  /** Se está grabando la emisión */
  recording?: boolean;
}

export interface AgentHeartbeat {
  serverId: number;
  clients: number;
  load: number[];
  streams: AgentStreamStatus[];
  /** Uso de CPU del nodo en % */
  cpu?: number;
  /** Memoria usada en % */
  mem?: number;
  memTotalMb?: number;
  /** Tráfico de red en Mbps */
  netInMbps?: number;
  netOutMbps?: number;
}

/** Muestra del histórico de un nodo (o de todos sumados). */
export interface MetricSample {
  t: number;
  cpu: number;
  mem: number;
  in: number;
  out: number;
  clients: number;
}

/** Lo que el nodo envía al panel al terminar una grabación o una subida. */
export interface MediaFileReport {
  path: string;
  ext: string;
  sizeBytes: number;
  durationSec: number;
  startedAt?: number;
  endedAt?: number;
}
