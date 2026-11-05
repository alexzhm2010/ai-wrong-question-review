#!/bin/sh
set -e

VERSION_FILE="/app/config/.app_version"
# Use local Prisma CLI from node_modules
PRISMA_BIN="node /app/node_modules/prisma/build/index.js"
SEED_ADMIN_SCRIPT="/app/dist-scripts/scripts/seed-admin.js"
REBUILD_TAGS_SCRIPT="/app/dist-scripts/scripts/rebuild-system-tags.js"

# Get current app version from package.json
CURRENT_VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "unknown")

# Fix permissions for config directory (optional local overrides)
mkdir -p /app/config
chown -R nextjs:nodejs /app/config 2>/dev/null || true

# Ensure DATABASE_URL is provided by the environment (Supabase / external PostgreSQL)
if [ -z "$DATABASE_URL" ]; then
    echo "[Entrypoint] ERROR: DATABASE_URL is not set. Please provide a PostgreSQL connection string."
    exit 1
fi

# Check for version upgrade
PREVIOUS_VERSION=""
if [ -f "$VERSION_FILE" ]; then
    PREVIOUS_VERSION=$(cat "$VERSION_FILE")
fi

# Run migrations to ensure DB schema is available and up to date.
echo "[Entrypoint] Running database migrations to sync schema..."
cd /app && $PRISMA_BIN migrate deploy --schema=./prisma/schema.prisma && {
    echo "[Entrypoint] Migrations completed successfully."
} || echo "[Entrypoint] Migration failed or no pending migrations."

# Always run seed after migrations to ensure admin user has correct role/isActive
echo "[Entrypoint] Ensuring admin user exists with correct role..."
cd /app && node "$SEED_ADMIN_SCRIPT" && {
    echo "[Entrypoint] Admin seed completed successfully."
} || echo "[Entrypoint] Admin seed failed (non-fatal, continuing...)."

# Check if version changed - rebuild system tags automatically
if [ "$PREVIOUS_VERSION" != "$CURRENT_VERSION" ]; then
    echo "[Entrypoint] Version upgrade detected: $PREVIOUS_VERSION -> $CURRENT_VERSION"
    echo "[Entrypoint] Rebuilding system tags to sync with new version..."
    cd /app && node "$REBUILD_TAGS_SCRIPT" && {
        echo "[Entrypoint] System tags rebuilt successfully."
    } || echo "[Entrypoint] Tag rebuild failed (non-fatal, continuing...)."
    echo "$CURRENT_VERSION" > "$VERSION_FILE"
fi

# HTTPS Setup
CERT_DIR="/app/certs"
CERT_FILE="$CERT_DIR/cert.pem"
KEY_FILE="$CERT_DIR/key.pem"

if [ "$HTTPS_ENABLED" = "true" ]; then
    echo "[Entrypoint] HTTPS enabled"

    mkdir -p "$CERT_DIR"
    chown nextjs:nodejs "$CERT_DIR"

    if [ ! -f "$CERT_FILE" ] || [ ! -f "$KEY_FILE" ]; then
        echo "[Entrypoint] 证书不存在，自动生成自签名证书..."

        CERT_CN="${CERT_DOMAIN:-localhost}"

        openssl req -x509 -newkey rsa:2048 \
            -keyout "$KEY_FILE" \
            -out "$CERT_FILE" \
            -days 3650 \
            -nodes \
            -subj "/CN=$CERT_CN" \
            2>/dev/null

        if [ $? -eq 0 ]; then
            echo "[Entrypoint] 自签名证书生成成功: CN=$CERT_CN"
            chown nextjs:nodejs "$CERT_FILE" "$KEY_FILE"
        else
            echo "[Entrypoint] 警告: 证书生成失败，HTTPS 将不可用"
        fi
    else
        echo "[Entrypoint] 使用已有证书: $CERT_FILE"
    fi

    if [ -f "$CERT_FILE" ] && [ -f "$KEY_FILE" ]; then
        echo "[Entrypoint] 启动 HTTPS 代理 (端口 443)..."
        su-exec nextjs:nodejs node /app/https-server.js &
    fi
fi

# Execute the main container command as nextjs user
exec su-exec nextjs:nodejs "$@"
