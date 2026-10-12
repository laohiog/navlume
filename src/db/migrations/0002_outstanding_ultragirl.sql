CREATE TABLE `personal_categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `personal_categories_userId_idx` ON `personal_categories` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `personal_categories_userId_id_unique` ON `personal_categories` (`user_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `personal_categories_one_default_per_user` ON `personal_categories` (`user_id`) WHERE "personal_categories"."is_default" = 1;--> statement-breakpoint
CREATE TABLE `personal_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`category_id` integer NOT NULL,
	`title` text NOT NULL,
	`url` text NOT NULL,
	`normalized_url` text NOT NULL,
	`icon_url` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`,`category_id`) REFERENCES `personal_categories`(`user_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `personal_links_userId_idx` ON `personal_links` (`user_id`);--> statement-breakpoint
CREATE INDEX `personal_links_categoryId_idx` ON `personal_links` (`category_id`);