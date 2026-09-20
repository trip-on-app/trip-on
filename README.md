# Trip ON AI Server Dashboard

Web dashboard for monitoring and controlling the local Qwen/Ollama servers used by Trip ON.

## Features

- PC1 / PC2 online status
- CPU, RAM, GPU and VRAM usage
- GPU temperature
- Ollama / Qwen / Cloudflare Tunnel status
- Active requests and average latency
- Drain / Resume controls
- Restart Qwen
- Restart Tunnel
- Restart PC
- Shutdown PC
- Password confirmation for dangerous commands
- Responsive desktop/mobile layout
- Demo mode until the Cloudflare Worker API is connected

## API contract

The frontend is ready to connect to a Cloudflare Worker.

### GET `/api/servers`

Expected response:

```json
{
  "servers": [
    {
      "id": "pc1",
      "name": "PC 1",
      "online": true,
      "cpu": 42,
      "ramUsedGb": 14.2,
      "ramTotalGb": 32,
      "gpu": 27,
      "vramUsedGb": 3.4,
      "vramTotalGb": 8,
      "gpuTempC": 63,
      "ollama": true,
      "qwen": true,
      "tunnel": true,
      "draining": false,
      "activeRequests": 1,
      "latencyMs": 1800,
      "lastSeen": "2026-09-20T21:50:00+09:00"
    }
  ]
}
```

### POST `/api/control`

Example:

```json
{
  "serverId": "pc2",
  "action": "restart_pc",
  "password": "..."
}
```

Supported actions:

- `restart_qwen`
- `restart_tunnel`
- `drain`
- `resume`
- `restart_pc`
- `shutdown`

Do not expose the Windows PCs directly to the public internet. The PC agents should poll or authenticate to the Cloudflare Worker.

## Run locally

Open `index.html` directly, or serve the folder with any static web server.

The dashboard starts in demo mode when the backend API is not available.
