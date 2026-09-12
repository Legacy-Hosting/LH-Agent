module.exports = {
  apps: [{
    name: 'lh-agent',
    cwd: __dirname,
    script: 'dist/index.js',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '192M',
    kill_timeout: 10000,
    time: true,
    env: { NODE_ENV: 'production' },
  }],
}
