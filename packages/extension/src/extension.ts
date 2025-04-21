import * as vscode from 'vscode';
import { BidiHttpTransport } from './bidi-http-transport';
import { registerVSCodeCommands } from './commands';
import { createMcpServer, extensionDisplayName } from './mcp-server';
import { DIFF_VIEW_URI_SCHEME } from './utils/DiffViewProvider';

// MCP Server のステータスを表示するステータスバーアイテム
let serverStatusBarItem: vscode.StatusBarItem;
let transport: BidiHttpTransport;

// ステータスバーを更新する関数
function updateServerStatusBar(status: 'running' | 'stopped' | 'starting' | 'tool_list_updated') {
  if (!serverStatusBarItem) {
    return;
  }

  switch (status) {
    case 'running':
      serverStatusBarItem.text = '$(server) MCP Server';
      serverStatusBarItem.tooltip = 'MCP Server is running';
      serverStatusBarItem.command = 'mcpServer.stopServer';
      break;
    case 'starting':
      serverStatusBarItem.text = '$(sync~spin) MCP Server';
      serverStatusBarItem.tooltip = 'Starting...';
      serverStatusBarItem.command = undefined;
      break;
    case 'tool_list_updated':
      serverStatusBarItem.text = '$(warning) MCP Server';
      serverStatusBarItem.tooltip = 'Tool list updated - Restart MCP Client';
      serverStatusBarItem.command = 'mcpServer.stopServer';
      break;
    case 'stopped':
    default:
      serverStatusBarItem.text = '$(circle-slash) MCP Server';
      serverStatusBarItem.tooltip = 'MCP Server is not running';
      serverStatusBarItem.command = 'mcpServer.toggleActiveStatus';
      break;
  }
  serverStatusBarItem.show();
}

export const activate = async (context: vscode.ExtensionContext) => {
  console.log('LMLMLM', vscode.lm.tools);

  // Create the output channel for logging
  const outputChannel = vscode.window.createOutputChannel(extensionDisplayName);
  outputChannel.appendLine(`Activating ${extensionDisplayName}...`);

  // Initialize the MCP server instance
  const mcpServer = createMcpServer(outputChannel);

  // Create status bar item
  serverStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(serverStatusBarItem);

  // Server start function
  async function startServer(port: number) {
    // Check if we're in a remote SSH environment
    const isRemoteSSH = vscode.env.remoteName === 'ssh-remote';
    
    if (isRemoteSSH) {
      outputChannel.appendLine(`DEBUG: Detected SSH remote environment: ${vscode.env.remoteName}`);
      
      // Automatically set up port forwarding if needed
      try {
        // VSCodeには、直接ポートを転送するAPIは公開されていないため、
        // 代わりに自動転送を促す
        const forwardPortCommand = 'remote-ssh.forwardPort';
        outputChannel.appendLine(`DEBUG: Checking if command '${forwardPortCommand}' is available`);
        
        const commands = await vscode.commands.getCommands();
        if (commands.includes(forwardPortCommand)) {
          outputChannel.appendLine(`DEBUG: Attempting to forward port ${port}`);
          await vscode.commands.executeCommand(forwardPortCommand, { port });
          outputChannel.appendLine(`DEBUG: Port ${port} forwarding initiated`);
        } else {
          outputChannel.appendLine(`WARNING: Port forwarding command not available. VSCode may automatically forward the port.`);
        }
      } catch (error) {
        outputChannel.appendLine(`WARNING: Failed to set up port forwarding: ${error}`);
        // Continue anyway, as VSCode might still forward the port automatically
      }
      
      // SSH環境ではVSCodeが自動的にポートを転送することが多いため、
      // 明示的な転送設定が失敗しても続行する
      outputChannel.appendLine(`NOTE: VSCode typically auto-forwards ports in SSH environments. Proceeding...`);
    }
    
    outputChannel.appendLine(`DEBUG: Starting MCP Server on port ${port}...`);
    transport = new BidiHttpTransport(port, outputChannel);
    // サーバー状態変更のイベントハンドラを設定
    transport.onServerStatusChanged = (status) => {
      updateServerStatusBar(status);
    };

    await mcpServer.connect(transport); // connect calls transport.start().
    updateServerStatusBar(transport.serverStatus);
  }

  // Register Diff View Provider for file comparison functionality
  const diffContentProvider = new (class implements vscode.TextDocumentContentProvider {
    provideTextDocumentContent(uri: vscode.Uri): string {
      return Buffer.from(uri.query, "base64").toString("utf-8");
    }
  })();

  // DiffViewProvider の URI スキームを mcp-diff に変更
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(DIFF_VIEW_URI_SCHEME, diffContentProvider),
  );

  // Start server if configured to do so
  const mcpConfig = vscode.workspace.getConfiguration('mcpServer');
  const port = mcpConfig.get<number>('port', 60100);
  const autoForwardPort = mcpConfig.get<boolean>('autoForwardPort', true);
  
  // SSH環境では自動ポート転送を有効にする
  if (vscode.env.remoteName === 'ssh-remote' && autoForwardPort) {
    outputChannel.appendLine('SSH Remote environment detected. Setting up automatic port forwarding.');
    try {
      // VSCodeの自動ポート転送設定を確認
      await vscode.commands.executeCommand('remote.autoForwardPorts', true);
      outputChannel.appendLine('Automatic port forwarding enabled.');
      
      // ポートを明示的に転送リストに追加
      const remoteConfig = vscode.workspace.getConfiguration('remote');
      let portsToForward = remoteConfig.get<number[]>('portsAttributes', []);
      if (!portsToForward.includes(port)) {
        portsToForward.push(port);
        await remoteConfig.update('portsAttributes', portsToForward, vscode.ConfigurationTarget.Global);
        outputChannel.appendLine(`Added port ${port} to auto-forward list.`);
      }
    } catch (error) {
      outputChannel.appendLine(`Failed to configure automatic port forwarding: ${error}`);
    }
  }
  
  try {
    await startServer(port);
    outputChannel.appendLine(`MCP Server started on port ${port}.`);
  } catch (err) {
    outputChannel.appendLine(`Failed to start MCP Server: ${err}`);
  }

  // Register VSCode commands
  registerVSCodeCommands(context, mcpServer, outputChannel, startServer, transport);

  outputChannel.appendLine(`${extensionDisplayName} activated.`);
};

export function deactivate() {
  // Clean-up is managed by the disposables added in the activate method.
}
