import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import * as http from 'node:http';
import * as vscode from 'vscode';

export class BidiHttpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  onServerStatusChanged?: (status: 'running' | 'stopped' | 'starting' | 'tool_list_updated') => void;
  #serverStatus: 'running' | 'stopped' | 'starting' | 'tool_list_updated' = 'stopped';
  private pendingResponses = new Map<string | number, (resp: JSONRPCMessage) => void>();
  private httpServer?: http.Server; // Express server instance

  public get isServerRunning(): boolean {
    return this.serverStatus === 'running';
  }

  private set serverStatus(status: 'running' | 'stopped' | 'starting' | 'tool_list_updated') {
    this.#serverStatus = status;
    if (this.onServerStatusChanged) {
      this.onServerStatusChanged(status);
    }
  }

  public get serverStatus(): 'running' | 'stopped' | 'starting' | 'tool_list_updated' {
    return this.#serverStatus;
  }

  constructor(
    readonly listenPort: number,
    private readonly outputChannel: vscode.OutputChannel
  ) { }

  async requestHandover(): Promise<boolean> {
    this.outputChannel.appendLine('Requesting server handover');

    // Notify that we're requesting handover
    this.serverStatus = 'starting';

    try {
      // SSH環境では別のアプローチが必要
      const isRemoteSSH = process.env.VSCODE_REMOTE_SERVER_PATH !== undefined;
      let url = `http://localhost:${this.listenPort}/request-handover`;
      
      if (isRemoteSSH) {
        // SSH環境では、ローカルホストへの直接アクセスではなく、
        // VSCodeのポート転送を通じてアクセスする必要がある
        url = `http://127.0.0.1:${this.listenPort}/request-handover`;
        this.outputChannel.appendLine(`SSH environment detected. Using URL: ${url}`);
      }

      // 現在のサーバーに対してハンドオーバーリクエストを送信
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      const data = await response.json() as { success: boolean };

      if (data.success) {
        this.outputChannel.appendLine('Handover request accepted');

        // ハンドオーバーが成功したら、1秒待ってからサーバーを再起動する
        this.outputChannel.appendLine('Waiting 1 second before starting server...');
        await new Promise(resolve => setTimeout(resolve, 1000));

        try {
          await this.start();
          this.outputChannel.appendLine('Server restarted after successful handover');
          return true;
        } catch (startErr) {
          const startErrorMessage = startErr instanceof Error ? startErr.message : String(startErr);
          this.outputChannel.appendLine(`Failed to restart server after handover: ${startErrorMessage}`);
          return false;
        }
      } else {
        this.outputChannel.appendLine('Handover request rejected');
        return false;
      }
    } catch (err) {
      // エラーが発生した場合（サーバーが起動していない場合など）
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.outputChannel.appendLine(`Handover request failed: ${errorMessage}`);

      // SSH環境の場合、より詳細なエラー情報を提供
      if (process.env.VSCODE_REMOTE_SERVER_PATH !== undefined) {
        this.outputChannel.appendLine('SSH environment detected. This might be a network connectivity issue.');
        this.outputChannel.appendLine('Checking if port is already forwarded...');
      }

      // ハンドオーバーリクエストが失敗した場合も、1秒待ってからサーバーを起動してみる
      this.outputChannel.appendLine('Waiting 1 second before starting server...');
      await new Promise(resolve => setTimeout(resolve, 1000));

      try {
        await this.start();
        this.outputChannel.appendLine('Server started after failed handover request');
        return true;
      } catch (startErr) {
        const startErrorMessage = startErr instanceof Error ? startErr.message : String(startErr);
        this.outputChannel.appendLine(`Failed to start server: ${startErrorMessage}`);
        return false;
      }
    }
  }

  async start(): Promise<void> {
    this.serverStatus = 'starting';

    const app = express();

    app.get('/ping', (_req: express.Request, res: express.Response) => {
      const isRemoteSSH = process.env.VSCODE_REMOTE_SERVER_PATH !== undefined;
      this.outputChannel.appendLine(`Received ping request${isRemoteSSH ? ' (SSH Remote)' : ''}`);
      const response = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        serverRunning: this.isServerRunning,
        environment: isRemoteSSH ? 'ssh-remote' : 'local'
      };

      res.send(response);
    });

    // Endpoint to handle handover requests
    app.post('/request-handover', express.json(), (_req: express.Request, res: express.Response) => {
      this.outputChannel.appendLine('Received handover request');

      // Accept the handover request
      res.send({ success: true });

      // Actually stop the server
      if (this.httpServer) {
        this.outputChannel.appendLine('Stopping server due to handover request');
        this.httpServer.close();
        this.httpServer = undefined;
      }

      // Set server to not running after sending response
      this.serverStatus = 'stopped';

      this.outputChannel.appendLine('Server is now not running due to handover request');
    });

    app.post('/notify-tools-updated', express.json(), (_req: express.Request, res: express.Response) => {
      this.outputChannel.appendLine('Received tools updated notification');
      vscode.window.showWarningMessage('The Tool List has been updated. Please restart the MCP Client (e.g., Claude Desktop) to notify it of the new Tool List. (For Claude Desktop, click the top hamburger menu -> File -> Exit.)');
      this.serverStatus = 'tool_list_updated';

      res.send({ success: true });
    });

    app.post('/', express.json(), async (req: express.Request, res: express.Response) => {
      this.outputChannel.appendLine('Received message: ' + JSON.stringify(req.body));
      try {
        const message = req.body as JSONRPCMessage;

        if (this.serverStatus === 'tool_list_updated' && (message as { method: string }).method === 'tools/list') {
          this.serverStatus = 'running';
        }

        if (this.onmessage) {
          if ('id' in message) {
            // Create a new promise for the response
            const responsePromise = new Promise<JSONRPCMessage>((resolve) => {
              this.pendingResponses.set(message.id, resolve);
            });
            // Handle the request and wait for response
            this.onmessage(message);
            const resp = await responsePromise;
            res.send(resp);
          } else {
            // Handle the request without waiting for response
            this.onmessage(message);
            res.send('{ "success": true }');
          }
        } else {
          res.status(500).send('No message handler');
        }
      } catch (err) {
        this.outputChannel.appendLine('Error handling message: ' + err);
        res.status(500).send('Internal Server Error');
      }
    });

    // Only try to listen on the specified port
    const startServer = (port: number): Promise<number> => {
      console.trace('Starting server on port: ' + port);
      return new Promise((resolve, reject) => {
        // In SSH remote environment, bind to all interfaces to support port forwarding
        const isRemoteSSH = process.env.VSCODE_REMOTE_SERVER_PATH !== undefined;
        const bindAddress = isRemoteSSH ? '0.0.0.0' : 'localhost';
        
        const server = app.listen(port, bindAddress)
          .once('listening', () => {
            this.httpServer = server; // Store server instance
            const addr = server.address();
            const boundAddress = typeof addr === 'string' ? addr : `${addr?.address}:${addr?.port}`;
            this.outputChannel.appendLine(`MCP Server running at ${boundAddress}${isRemoteSSH ? ' (SSH Remote - bound to all interfaces)' : ''}`);
            resolve(port);
          })
          .once('error', (err: NodeJS.ErrnoException) => {
            this.outputChannel.appendLine(`Failed to listen on port ${port}: ${err.message}${isRemoteSSH ? ' (SSH Remote)' : ''}`);
            reject(err);
          });
      });
    };

    try {
      const isRemoteSSH = process.env.VSCODE_REMOTE_SERVER_PATH !== undefined;
      this.outputChannel.appendLine(`Starting server in ${isRemoteSSH ? 'SSH Remote' : 'Local'} environment`);
      
      // Add environment debugging
      this.outputChannel.appendLine(`Environment details:`);
      this.outputChannel.appendLine(`- VSCODE_REMOTE_SERVER_PATH: ${process.env.VSCODE_REMOTE_SERVER_PATH || 'not set'}`);
      this.outputChannel.appendLine(`- Listening port: ${this.listenPort}`);
      
      await startServer(this.listenPort);

      // Server status is automatically set to running when httpServer is set
      this.serverStatus = 'running';
      this.outputChannel.appendLine('Server is now running');
      
      if (isRemoteSSH) {
        this.outputChannel.appendLine('Note: VSCode should automatically forward this port to your local machine');
      }
    } catch (err) {
      this.serverStatus = 'stopped';
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.outputChannel.appendLine(`Failed to start server on port ${this.listenPort}: ${errorMessage}`);
      throw new Error(`Failed to bind to port ${this.listenPort}: ${errorMessage}`);
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.outputChannel.appendLine('Sending message: ' + JSON.stringify(message));

    if ('id' in message && 'result' in message) {
      // This is a response to a previous request
      const resolve = this.pendingResponses.get(message.id);
      if (resolve) {
        resolve(message);
        this.pendingResponses.delete(message.id);
      } else {
        this.outputChannel.appendLine(`No pending response for ID: ${message.id}`);
      }
    }
  }

  async close(): Promise<void> {
    this.serverStatus = 'stopped';
    if (this.httpServer) {
      this.outputChannel.appendLine('Closing server');
      this.httpServer.close();
      this.httpServer = undefined;
    }
  }
}
