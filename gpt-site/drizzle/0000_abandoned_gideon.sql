CREATE TABLE `call_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`tool` text NOT NULL,
	`args` text NOT NULL,
	`ok` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`output` text NOT NULL,
	`error` text
);
