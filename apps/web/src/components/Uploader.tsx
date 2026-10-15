import { useRef, useState } from 'react';
import { UploadCloud } from 'lucide-react';
import { api } from '../api';
import { useRefs } from '../refs';
import { Field, useToast } from './ui';

export interface UploadTarget {
  kind: 'movie' | 'episode';
  /** Para episodios */
  series_id?: number;
}

interface Props extends UploadTarget {
  /** Campos adicionales que rellena la pantalla (título, categoría, temporada…) */
  meta: () => Record<string, unknown> | string;
  onDone: () => void;
  buttonLabel?: string;
}

const fmtSize = (b: number) => (b > 1073741824 ? `${(b / 1073741824).toFixed(1)} GB` : `${Math.round(b / 1048576)} MB`);

/**
 * Sube un vídeo directamente al nodo elegido con barra de progreso.
 * El panel solo da el permiso; el fichero no pasa por el servidor principal.
 */
export function Uploader({ kind, series_id, meta, onDone, buttonLabel }: Props) {
  const refs = useRefs();
  const toast = useToast();
  const servers = refs.servers.filter((s) => s.enabled);
  const [serverId, setServerId] = useState<number | ''>(servers[0]?.id ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);

  const start = async () => {
    setError(null);
    if (!file) return setError('Elige un fichero de vídeo');
    if (!serverId) return setError('Elige el servidor donde se guardará');
    const m = meta();
    if (typeof m === 'string') return setError(m);
    let url: string;
    try {
      const grant = await api<{ url: string }>('POST', '/uploads', { kind, series_id, serverId, filename: file.name, ...m });
      url = grant.url;
    } catch (e) {
      return setError((e as Error).message);
    }
    setProgress(0);
    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    xhr.open('PUT', url);
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && setProgress(e.loaded / e.total);
    xhr.onload = () => {
      xhrRef.current = null;
      if (xhr.status === 201) {
        toast(kind === 'movie' ? 'Vídeo subido y publicado' : 'Episodio subido y publicado');
        setProgress(null);
        setFile(null);
        onDone();
      } else {
        setProgress(null);
        let msg = `El servidor respondió ${xhr.status}`;
        try {
          msg = JSON.parse(xhr.responseText).error ?? msg;
        } catch {
          // respuesta no JSON
        }
        setError(msg);
      }
    };
    xhr.onerror = () => {
      xhrRef.current = null;
      setProgress(null);
      setError('No se pudo conectar con el servidor de destino. Comprueba que su URL pública es accesible desde este navegador.');
    };
    xhr.send(file);
  };

  const cancel = () => {
    xhrRef.current?.abort();
    xhrRef.current = null;
    setProgress(null);
  };

  return (
    <div className="subsection">
      {error && <div className="alert">{error}</div>}
      <div className="field-row">
        <Field label="Fichero de vídeo" htmlFor="up-file">
          <input
            id="up-file"
            className="input"
            type="file"
            accept="video/*,.mkv,.ts"
            disabled={progress != null}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </Field>
        <Field label="Guardar en el servidor" htmlFor="up-server">
          <select
            id="up-server"
            className="select"
            value={serverId}
            disabled={progress != null}
            onChange={(e) => setServerId(Number(e.target.value))}
          >
            {servers.length === 0 && <option value="">No hay servidores</option>}
            {servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {file && progress == null && <span className="help">{file.name}, {fmtSize(file.size)}</span>}
      {progress != null ? (
        <div className="field">
          <div className="progress" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
            <div style={{ width: `${progress * 100}%` }} />
          </div>
          <span className="help">
            {progress < 1 ? `Subiendo… ${Math.round(progress * 100)}% de ${file ? fmtSize(file.size) : ''}` : 'Procesando en el servidor…'}
          </span>
          <div>
            <button className="btn small" onClick={cancel}>
              Cancelar subida
            </button>
          </div>
        </div>
      ) : (
        <div>
          <button className="btn primary" onClick={start} disabled={!file}>
            <UploadCloud size={16} /> {buttonLabel ?? 'Subir vídeo'}
          </button>
        </div>
      )}
    </div>
  );
}
