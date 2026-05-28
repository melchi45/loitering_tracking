# Operations Guide
# MongoDB Setup

| | |
|---|---|
| **Document Reference** | OPS-LTS2026-MDB-001 |
| **Document Type** | Operations Guide |
| **Parent System** | LTS-2026-001 Loitering Detection & Tracking System |
| **Issue Date** | 2026-05-28 |
| **Status** | **✅ Active — MongoDB 5.0.33 running on Ubuntu 18.04, DB_TYPE=mongodb** |
| **Repository** | [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking) |

---

By default the server persists all data to `server/storage/lts.json` (`DB_TYPE=json`).  
This guide describes how to switch to **MongoDB 5.0** as the primary database, with `lts.json` kept as a hot-standby backup.

> **Tested on:** Ubuntu 18.04 LTS (Bionic) · MongoDB 5.0.33 · AVX-capable CPU required

## Step 1 — Install MongoDB 5.0

```bash
# 1. Import MongoDB GPG key
curl -fsSL https://www.mongodb.org/static/pgp/server-5.0.asc | sudo apt-key add -

# 2. Add apt repository (Ubuntu 18.04 Bionic)
echo "deb [ arch=amd64,arm64 ] https://repo.mongodb.org/apt/ubuntu bionic/mongodb-org/5.0 multiverse" \
  | sudo tee /etc/apt/sources.list.d/mongodb-org-5.0.list

# 3. Install
sudo apt-get update -q
sudo apt-get install -y mongodb-org

# Verify
mongod --version   # → db version v5.0.x
```

> **Ubuntu 20.04 / 22.04:** Replace `bionic` with `focal` or `jammy` in the repository URL.

## Step 2 — Start & Enable the Service

```bash
sudo systemctl start mongod
sudo systemctl enable mongod        # auto-start on boot
sudo systemctl status mongod        # should show: active (running)

# Verify connection
mongosh --eval "db.runCommand({ping:1})" --quiet
```

## Step 3 — Migrate Existing Data from lts.json

Run this once to import the current JSON store into MongoDB:

```bash
cd /path/to/loitering_tracking

python3 << 'EOF'
import json, subprocess, os, tempfile

data = json.load(open('server/storage/lts.json'))
total = 0
for table, docs in data.items():
    if not isinstance(docs, list) or len(docs) == 0:
        print(f'{table}: (empty, skip)')
        continue
    tmp = tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False)
    for doc in docs:
        tmp.write(json.dumps(doc) + '\n')
    tmp.close()
    result = subprocess.run(
        ['mongoimport', '--db', 'lts', '--collection', table, '--drop', '--file', tmp.name],
        capture_output=True, text=True
    )
    os.unlink(tmp.name)
    if result.returncode == 0:
        print(f'{table}: {len(docs)} docs OK')
        total += len(docs)
    else:
        print(f'{table}: FAILED — {result.stderr.strip()}')
print(f'\nTotal: {total} documents imported into MongoDB \'lts\' database')
EOF
```

Expected output (numbers will vary):
```
cameras: 9 docs OK
settings: 2 docs OK
detectionSnapshots: 431 docs OK
...
Total: 419 documents imported into MongoDB 'lts' database
```

## Step 4 — Switch DB_TYPE in server/.env

```dotenv
# server/.env
DB_TYPE=mongodb
MONGODB_URI=mongodb://localhost:27017/lts
MONGODB_DB_NAME=lts
```

## Step 5 — Restart the Server

```bash
# From workspace root
fuser -k 3443/tcp 2>/dev/null   # stop running server
npm start
```

Confirm in logs (`/tmp/lts.log`):
```
[MongoDB] connected → mongodb://localhost:27017/lts
[DB] Storage mode: MongoDB (JSON as hot-standby backup)
[Server] Starting 9 registered camera pipeline(s)
[Server] Loitering Tracking System backend listening on port 3443
```

## Storage Mode Comparison

| Mode | `DB_TYPE` | Persistence | Best For |
|---|:---:|---|---|
| JSON (default) | `json` | `server/storage/lts.json` | Dev / single-node |
| MongoDB | `mongodb` | MongoDB collections + JSON hot-standby | Production / multi-node |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `mongod: NOT FOUND` after install | PATH not refreshed | Run `hash -r` or open a new terminal |
| `AVX` error on start | CPU lacks AVX support | Use MongoDB 4.4 instead (does not require AVX) |
| Data lost after server restart | `STORAGE_PATH` resolves to wrong directory | Ensure `STORAGE_PATH=./storage` and server cwd = `server/`; verify with `grep STORAGE /tmp/lts.log` |
| `[DB] MongoDB ... empty — seeding from JSON` | Collection empty on first start | Normal behaviour — JSON fallback seeds MongoDB automatically |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — MongoDB 5.0 installation and migration guide for Ubuntu 18.04 |
