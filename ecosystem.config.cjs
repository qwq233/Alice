// pm2 start ecosystem.config.cjs        ← 拉起全部（runtime + 内部服务）
// pm2 start ecosystem.config.cjs --only alice-runtime  ← 仅 runtime

// 内部服务端口（高位，避开常用端口）
const WD_TAGGER_PORT = 39100;
const ANIME_CLASSIFY_PORT = 39101;

module.exports = {
  apps: [
    {
      name: "alice-runtime",
      cwd: "./runtime",
      script: "pnpm",
      args: "run dev",
      autorestart: false,
      watch: false,
      env: {
        NODE_ENV: "development",
      },
    },
    {
      name: "wd-tagger",
      cwd: process.env.WD_TAGGER_DIR || "./services/wd14-tagger-server",
      script: "main.py",
      interpreter: "pdm",
      interpreter_args: "run python3",
      autorestart: true,
      max_restarts: 3,
      restart_delay: 10000,
      watch: false,
      env: {
        SERVER_PORT: WD_TAGGER_PORT,
      },
    },
    {
      name: "anime-classify",
      cwd: "./services/anime-classify",
      script: "server.py",
      interpreter: "uv",
      interpreter_args: "run python3",
      autorestart: true,
      max_restarts: 3,
      restart_delay: 10000,
      watch: false,
      env: {
        PORT: ANIME_CLASSIFY_PORT,
      },
    },
  ],
};
