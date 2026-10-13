// Конфигурация PM2 для запуска на сервере (VPS)
module.exports = {
  apps: [
    {
      name: 'investhouse',
      script: 'server.js',
      instances: 1,
      env: { NODE_ENV: 'production', PORT: 3000 },
    },
  ],
};
