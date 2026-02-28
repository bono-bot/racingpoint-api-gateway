module.exports = {
  apps: [{
    name: 'racingpoint-api-gateway',
    script: 'server.js',
    instances: 1,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    max_memory_restart: '512M',
    env_file: '.env',
    error_file: './logs/error.log',
    out_file: './logs/out.log',
  }],
};
