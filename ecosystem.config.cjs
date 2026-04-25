module.exports = {
  apps: [
    {
      name: 'trading-server',
      script: 'packages/server/dist/index.js',
      cwd: __dirname,
      watch: false,
      autorestart: true,
      restart_delay: 3000,
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
        PORT: 4242,
      },
    },
  ],
};
