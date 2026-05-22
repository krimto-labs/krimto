# Installing Krimto for OpenCode

Krimto is an MCP server. Run it, then point OpenCode at it.

1. Start the server:

   ```bash
   docker run -d -p 8080:8080 -v ~/.krimto:/data ghcr.io/krimto-labs/server
   ```

2. Add Krimto to your OpenCode MCP configuration:

   ```json
   {
     "mcp": {
       "krimto": { "type": "remote", "url": "http://localhost:8080" }
     }
   }
   ```

See the repository `README.md` for authentication and scope details.
