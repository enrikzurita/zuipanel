-- Emisión propia (RTMP desde cámara u OBS), grabación automática y subidas

ALTER TABLE streams
  ADD COLUMN input_type ENUM('pull','push') NOT NULL DEFAULT 'pull' COMMENT 'pull = el nodo lee una URL; push = la cámara/OBS envía al nodo' AFTER sources,
  ADD COLUMN stream_key VARCHAR(64) NULL COMMENT 'Clave de emisión para canales push' AFTER input_type,
  ADD COLUMN record TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Grabar cada emisión como VOD',
  ADD COLUMN record_category_id INT UNSIGNED NULL COMMENT 'Categoría de película para las grabaciones',
  ADD UNIQUE KEY uq_stream_key (stream_key),
  ADD CONSTRAINT fk_streams_record_cat FOREIGN KEY (record_category_id) REFERENCES categories(id) ON DELETE SET NULL;

ALTER TABLE movies
  ADD COLUMN origin ENUM('manual','recording','upload') NOT NULL DEFAULT 'manual' AFTER enabled,
  ADD COLUMN source_stream_id INT UNSIGNED NULL COMMENT 'Canal del que sale la grabación' AFTER origin,
  ADD KEY idx_origin (origin);
