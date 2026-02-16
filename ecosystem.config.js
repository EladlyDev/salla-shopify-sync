module.exports = {
    apps: [
        {
            name: 'salla-shopify-sync',
            script: 'dist/server.js',
            instances: 1, // Must be 1 — the app uses in-memory mutexes (async-mutex)
            exec_mode: 'fork',
            autorestart: true,
            max_restarts: 10,
            restart_delay: 5000,
            watch: false,
            max_memory_restart: '512M',
            env_production: {
                NODE_ENV: 'production',
            },
            // Graceful shutdown
            kill_timeout: 5000,
            listen_timeout: 10000,
            // Logging
            log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
            error_file: 'logs/error.log',
            out_file: 'logs/out.log',
            merge_logs: true,
        },
    ],
};
