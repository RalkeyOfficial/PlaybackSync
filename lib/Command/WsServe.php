<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Command;

use OCA\PlaybackSync\AppInfo\Application;
use OCA\PlaybackSync\WebSocket\MessageRouter;
use OCA\PlaybackSync\WebSocket\Tick;
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

		$loop = Loop::get();
		$socket = new SocketServer($host . ':' . $port, [], $loop);

		$server = new IoServer(
			new HttpServer(new WsServer($this->router)),
			$socket,
			$loop,
		);

		$this->tick->start();

		$msg = sprintf('PlaybackSync WS daemon listening on %s:%d', $host, $port);
		$output->writeln($msg);
		$this->logger->info($msg);

		$server->run();

		return Command::SUCCESS;
	}
}
