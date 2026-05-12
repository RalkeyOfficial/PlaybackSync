<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Command;

use OCA\PlaybackSync\AppInfo\Application;
use OCA\PlaybackSync\WebSocket\Admin\EventStreamController;
use OCA\PlaybackSync\WebSocket\Admin\HealthController;
use OCA\PlaybackSync\WebSocket\Admin\PresenceHttpServer;
use OCA\PlaybackSync\WebSocket\MessageRouter;
use OCA\PlaybackSync\WebSocket\RoomRegistry;
use OCA\PlaybackSync\WebSocket\Tick;
use OCP\App\IAppManager;
use OCP\IAppConfig;
use Psr\Log\LoggerInterface;
use Ratchet\Http\HttpServer;
use Ratchet\Server\IoServer;
use Ratchet\WebSocket\WsServer;
use React\EventLoop\Loop;
use React\Socket\SocketServer;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;

/**
 * Long-running daemon: binds a TCP port and runs the Ratchet event loop
 * until the process is killed. The reverse proxy in front of Nextcloud
 * forwards `/apps/playbacksync/ws/{uuid}` requests here.
 */
class WsServe extends Command {

	public function __construct(
		private readonly IAppConfig $appConfig,
		private readonly LoggerInterface $logger,
		private readonly MessageRouter $router,
		private readonly Tick $tick,
		private readonly PresenceHttpServer $presenceHttp,
		private readonly RoomRegistry $registry,
		private readonly IAppManager $appManager,
		private readonly EventStreamController $eventStreamController,
	) {
		parent::__construct();
	}

	protected function configure(): void {
		$this
			->setName('playbacksync:ws-serve')
			->setDescription('Run the PlaybackSync WebSocket sync server')
			->addOption('host', null, InputOption::VALUE_REQUIRED, 'Bind host (overrides app config ws_host)')
			->addOption('port', null, InputOption::VALUE_REQUIRED, 'Bind port (overrides app config ws_port)');
	}

	protected function execute(InputInterface $input, OutputInterface $output): int {
		$host = (string)($input->getOption('host')
			?? $this->appConfig->getValueString(Application::APP_ID, 'ws_host', '127.0.0.1'));
		$port = (int)($input->getOption('port')
			?? $this->appConfig->getValueString(Application::APP_ID, 'ws_port', '8765'));

		$startedAtMs = (int)(microtime(true) * 1000);

		$loop = Loop::get();
		$socket = new SocketServer($host . ':' . $port, [], $loop);

		$server = new IoServer(
			new HttpServer(new WsServer($this->router)),
			$socket,
			$loop,
		);

		// Wire the daemon's healthcheck handler. Built here (not via the DI
		// container) so the captured `startedAtMs` reflects the actual boot
		// moment instead of whenever the container happened to resolve us.
		$this->presenceHttp->setHealthController(new HealthController(
			$this->registry,
			$this->tick,
			$this->appManager->getAppVersion(Application::APP_ID),
			$startedAtMs,
		));
		$this->eventStreamController->setDaemonStartedAtMs($startedAtMs);

		$this->tick->start();

		$msg = sprintf('PlaybackSync WS daemon listening on %s:%d', $host, $port);
		$output->writeln($msg);
		$this->logger->info($msg);

		$this->maybeStartAdminServer($loop, $output);

		$server->run();

		return Command::SUCCESS;
	}

	/**
	 * Start the loopback admin HTTP server if a shared secret is configured.
	 * Without a secret the admin endpoint would be effectively unauthenticated,
	 * so we refuse to start it — the WS server itself is unaffected.
	 */
	private function maybeStartAdminServer(\React\EventLoop\LoopInterface $loop, OutputInterface $output): void {
		$app = Application::APP_ID;
		$secret = $this->appConfig->getValueString($app, 'ws_admin_secret', '');
		if ($secret === '') {
			$output->writeln('<comment>Admin HTTP server NOT started: ws_admin_secret is empty</comment>');
			$this->logger->warning('PresenceHttpServer disabled: ws_admin_secret is not configured');
			return;
		}

		$adminHost = $this->appConfig->getValueString($app, 'ws_admin_host', '127.0.0.1');
		$adminPort = $this->appConfig->getValueInt($app, 'ws_admin_port', 8766);
		$adminSocket = new SocketServer($adminHost . ':' . $adminPort, [], $loop);

		new IoServer(
			new HttpServer($this->presenceHttp),
			$adminSocket,
			$loop,
		);

		$msg = sprintf('PlaybackSync admin HTTP listening on %s:%d', $adminHost, $adminPort);
		$output->writeln($msg);
		$this->logger->info($msg);
	}
}
