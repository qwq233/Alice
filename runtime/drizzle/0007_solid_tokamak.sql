CREATE TABLE `llm_sessions` (
	`session_key` text PRIMARY KEY NOT NULL,
	`provider_name` text NOT NULL,
	`model` text NOT NULL,
	`system_fingerprint` text NOT NULL,
	`previous_response_id` text NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_llm_sessions_updated_at` ON `llm_sessions` (`updated_at_ms`);