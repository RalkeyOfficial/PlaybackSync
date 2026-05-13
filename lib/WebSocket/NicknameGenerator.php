<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket;

final class NicknameGenerator {
	private static array $adjectives = [
		'Bold', 'Brave', 'Bright', 'Brisk', 'Calm', 'Clever', 'Cool', 'Crisp',
		'Daring', 'Dawn', 'Deft', 'Eager', 'Fair', 'Fancy', 'Fast', 'Fierce',
		'Fond', 'Gentle', 'Giant', 'Glad', 'Golden', 'Grand', 'Happy', 'Hardy',
		'Keen', 'Kind', 'Lazy', 'Lively', 'Loud', 'Lucky', 'Merry', 'Mighty',
		'Noble', 'Nimble', 'Odd', 'Polite', 'Proud', 'Quick', 'Quiet', 'Rapid',
		'Rare', 'Regal', 'Royal', 'Rusty', 'Savvy', 'Sleek', 'Sly', 'Smart',
		'Snappy', 'Stark', 'Stout', 'Swift', 'Tame', 'Tidy', 'Tiny', 'Tough',
		'Witty', 'Wily', 'Wild', 'Zesty',
	];

	private static array $nouns = [
		'Badger', 'Bear', 'Bison', 'Buck', 'Camel', 'Cobra', 'Crane', 'Crow',
		'Deer', 'Drake', 'Eagle', 'Elk', 'Falcon', 'Ferret', 'Finch', 'Fox',
		'Frog', 'Goat', 'Goose', 'Hawk', 'Heron', 'Horse', 'Hound', 'Ibis',
		'Jay', 'Kite', 'Lamb', 'Lark', 'Lion', 'Lynx', 'Mink', 'Mole',
		'Moose', 'Moth', 'Mouse', 'Newt', 'Orca', 'Otter', 'Owl', 'Panda',
		'Pike', 'Pony', 'Quail', 'Raven', 'Robin', 'Shark', 'Sloth', 'Snake',
		'Stag', 'Swan', 'Tiger', 'Toad', 'Trout', 'Vole', 'Wolf', 'Wren',
		'Yak', 'Zebra',
	];

	public static function generate(): string {
		$adj  = self::$adjectives[random_int(0, count(self::$adjectives) - 1)];
		$noun = self::$nouns[random_int(0, count(self::$nouns) - 1)];
		$num  = random_int(10, 99);
		return $adj . $noun . $num;
	}
}
