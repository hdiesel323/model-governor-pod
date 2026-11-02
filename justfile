set shell := ["zsh", "-cu"]

# Run pod locally with native SQLite WAL engine
dev:
    npx tsx src/main.ts

# Run test suite
test:
    npm test

# Type check TypeScript
check:
    npx tsc --noEmit

# Scaffold a new pod instance from this template
scaffold name role domain:
    node bin/scaffold.js --name {{quote(name)}} --role {{quote(role)}} --domain {{quote(domain)}}

# Apply database schema to Cloudflare D1
cf-schema db_name:
    wrangler d1 execute {{db_name}} --remote --file=schema.sql -y

# Deploy pod to Cloudflare Workers
cf-deploy:
    wrangler deploy
