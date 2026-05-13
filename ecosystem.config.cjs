// PM2 ecosystem config for Docker container
// Manages both signals-bot and dashboard as a single unit

module.exports = {
  apps: [
    {
      name: 'signals-bot',
      script: 'bot/signals-bot.js',
      cwd: '/app',
      // Restart if CDP connection drops or TradingView is temporarily unavailable
      max_restarts: 20,
      restart_delay: 5000,
      exp_backoff_restart_delay: 10000,
      // Log to stdout for Docker
      error_file: '/dev/stdout',
      out_file: '/dev/stdout',
      log_file: '/dev/stdout',
      merge_logs: true,
      // Graceful shutdown
      kill_timeout: 10000,
      shutdown_with_message: true,
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'dashboard',
      script: 'bot/dashboard/server.js',
      cwd: '/app',
      // Dashboard is stable, minimal restarts
      max_restarts: 5,
      restart_delay: 3000,
      error_file: '/dev/stdout',
      out_file: '/dev/stdout',
      log_file: '/dev/stdout',
      merge_logs: true,
      kill_timeout: 5000,
      env: {
        NODE_ENV: 'production',
        DASHBOARD_PORT: '3456',
      },
    },
  ],
};
