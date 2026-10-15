-- ZuiPanel: esquema inicial
-- Los IDs de streams, películas, series y episodios se pueden fijar a mano
-- para conservar los de XUI al migrar (así las listas de los clientes no cambian).

CREATE TABLE servers (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name            VARCHAR(100) NOT NULL,
  public_url      VARCHAR(255) NOT NULL COMMENT 'URL a la que se redirige a los clientes, p. ej. http://s1.midominio.com:8080',
  is_main         TINYINT(1) NOT NULL DEFAULT 0,
  enabled         TINYINT(1) NOT NULL DEFAULT 1,
  max_clients     INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '0 = sin límite',
  last_heartbeat  DATETIME NULL,
  status          JSON NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE categories (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  type       ENUM('live','movie','series') NOT NULL,
  name       VARCHAR(255) NOT NULL,
  parent_id  INT UNSIGNED NOT NULL DEFAULT 0,
  sort       INT NOT NULL DEFAULT 0,
  KEY idx_type_sort (type, sort)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE transcode_profiles (
  id       INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name     VARCHAR(100) NOT NULL,
  options  JSON NOT NULL COMMENT 'Ver TranscodeOptions en packages/shared'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE streams (
  id                    INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name                  VARCHAR(255) NOT NULL,
  category_id           INT UNSIGNED NULL,
  sources               JSON NOT NULL COMMENT 'Array de URLs de origen; se rotan si una falla',
  icon                  VARCHAR(500) NOT NULL DEFAULT '',
  epg_channel_id        VARCHAR(255) NOT NULL DEFAULT '',
  on_demand             TINYINT(1) NOT NULL DEFAULT 1,
  transcode_profile_id  INT UNSIGNED NULL COMMENT 'NULL = remux (copy)',
  user_agent            VARCHAR(255) NULL,
  custom_sid            VARCHAR(100) NOT NULL DEFAULT '',
  enabled               TINYINT(1) NOT NULL DEFAULT 1,
  sort                  INT NOT NULL DEFAULT 0,
  added_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_category (category_id),
  CONSTRAINT fk_streams_category FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
  CONSTRAINT fk_streams_profile FOREIGN KEY (transcode_profile_id) REFERENCES transcode_profiles(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE stream_servers (
  stream_id  INT UNSIGNED NOT NULL,
  server_id  INT UNSIGNED NOT NULL,
  PRIMARY KEY (stream_id, server_id),
  CONSTRAINT fk_ss_stream FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE CASCADE,
  CONSTRAINT fk_ss_server FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE movies (
  id                   INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name                 VARCHAR(255) NOT NULL,
  category_id          INT UNSIGNED NULL,
  source_path          VARCHAR(1000) NOT NULL COMMENT 'Ruta del fichero en los nodos (p. ej. montaje rclone)',
  container_extension  VARCHAR(10) NOT NULL DEFAULT 'mp4',
  icon                 VARCHAR(500) NOT NULL DEFAULT '',
  tmdb_id              INT UNSIGNED NULL,
  rating               DECIMAL(3,1) NOT NULL DEFAULT 0,
  info                 JSON NULL COMMENT 'Metadatos (sinopsis, reparto, duración...)',
  enabled              TINYINT(1) NOT NULL DEFAULT 1,
  sort                 INT NOT NULL DEFAULT 0,
  added_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_category (category_id),
  CONSTRAINT fk_movies_category FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE movie_servers (
  movie_id   INT UNSIGNED NOT NULL,
  server_id  INT UNSIGNED NOT NULL,
  PRIMARY KEY (movie_id, server_id),
  CONSTRAINT fk_ms_movie FOREIGN KEY (movie_id) REFERENCES movies(id) ON DELETE CASCADE,
  CONSTRAINT fk_ms_server FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE series (
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name           VARCHAR(255) NOT NULL,
  category_id    INT UNSIGNED NULL,
  cover          VARCHAR(500) NOT NULL DEFAULT '',
  tmdb_id        INT UNSIGNED NULL,
  rating         DECIMAL(3,1) NOT NULL DEFAULT 0,
  info           JSON NULL,
  enabled        TINYINT(1) NOT NULL DEFAULT 1,
  sort           INT NOT NULL DEFAULT 0,
  added_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_modified  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_category (category_id),
  CONSTRAINT fk_series_category FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE series_servers (
  series_id  INT UNSIGNED NOT NULL,
  server_id  INT UNSIGNED NOT NULL,
  PRIMARY KEY (series_id, server_id),
  CONSTRAINT fk_srs_series FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE,
  CONSTRAINT fk_srs_server FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE episodes (
  id                   INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  series_id            INT UNSIGNED NOT NULL,
  season               INT UNSIGNED NOT NULL DEFAULT 1,
  episode_num          INT UNSIGNED NOT NULL DEFAULT 1,
  title                VARCHAR(255) NOT NULL DEFAULT '',
  source_path          VARCHAR(1000) NOT NULL,
  container_extension  VARCHAR(10) NOT NULL DEFAULT 'mp4',
  info                 JSON NULL,
  added_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_series (series_id, season, episode_num),
  CONSTRAINT fk_episodes_series FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE bouquets (
  id    INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name  VARCHAR(255) NOT NULL,
  sort  INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE bouquet_items (
  bouquet_id  INT UNSIGNED NOT NULL,
  item_type   ENUM('live','movie','series') NOT NULL,
  item_id     INT UNSIGNED NOT NULL,
  sort        INT NOT NULL DEFAULT 0,
  PRIMARY KEY (bouquet_id, item_type, item_id),
  KEY idx_item (item_type, item_id),
  CONSTRAINT fk_bi_bouquet FOREIGN KEY (bouquet_id) REFERENCES bouquets(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE user_lines (
  id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username         VARCHAR(100) NOT NULL,
  password         VARCHAR(100) NOT NULL,
  max_connections  INT UNSIGNED NOT NULL DEFAULT 1,
  exp_date         DATETIME NULL COMMENT 'NULL = sin caducidad',
  enabled          TINYINT(1) NOT NULL DEFAULT 1,
  is_trial         TINYINT(1) NOT NULL DEFAULT 0,
  allowed_outputs  JSON NULL COMMENT 'Array: ["ts","m3u8"]; NULL = todos',
  allowed_ips      JSON NULL COMMENT 'Array de IPs; NULL = cualquiera',
  notes            TEXT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE line_bouquets (
  line_id     INT UNSIGNED NOT NULL,
  bouquet_id  INT UNSIGNED NOT NULL,
  sort        INT NOT NULL DEFAULT 0,
  PRIMARY KEY (line_id, bouquet_id),
  CONSTRAINT fk_lb_line FOREIGN KEY (line_id) REFERENCES user_lines(id) ON DELETE CASCADE,
  CONSTRAINT fk_lb_bouquet FOREIGN KEY (bouquet_id) REFERENCES bouquets(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE epg_programmes (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  channel_id   VARCHAR(255) NOT NULL,
  start        DATETIME NOT NULL,
  stop         DATETIME NOT NULL,
  title        VARCHAR(500) NOT NULL DEFAULT '',
  description  TEXT NULL,
  lang         VARCHAR(10) NOT NULL DEFAULT '',
  KEY idx_channel_start (channel_id, start),
  KEY idx_stop (stop)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
