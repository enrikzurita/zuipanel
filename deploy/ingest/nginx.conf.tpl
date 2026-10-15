# Servidor de entrada RTMP de un nodo ZuiPanel (nginx + módulo RTMP).
# Las cámaras/OBS publican en rtmp://NODO:1935/live con la clave del canal.
# La URL del agente y la carga del módulo se rellenan al arrancar el contenedor.
__LOAD_MODULE__
user www-data;
worker_processes 1;
error_log /dev/stderr warn;

events {
    worker_connections 1024;
}

rtmp {
    server {
        listen 1935;
        chunk_size 4096;

        application live {
            live on;
            record off;

            # Publicar: cualquiera con una clave válida (lo decide el agente)
            allow publish all;
            on_publish __AGENT_URL__/ingest/publish;
            # Corta publicaciones que dejan de enviar datos
            drop_idle_publisher 15s;

            # Leer en crudo: solo la red interna (el agente y FFmpeg)
            allow play 127.0.0.1;
            allow play 10.0.0.0/8;
            allow play 172.16.0.0/12;
            deny play all;
        }
    }
}

http {
    access_log off;
    server {
        listen 8088;
        location /stat {
            rtmp_stat all;
            allow 127.0.0.1;
            allow 10.0.0.0/8;
            allow 172.16.0.0/12;
            deny all;
        }
    }
}
