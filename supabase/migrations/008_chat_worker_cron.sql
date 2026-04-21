-- ============================================================
-- pg_cron schedule for chat-worker
--
-- Runs every 10 seconds — claims up to N pending chat_jobs and
-- processes them (classify → generate → persist draft).
--
-- Requires pg_cron + pg_net extensions (already enabled in Supabase).
-- Adjust the URL to your project's Edge Function URL after deployment.
--
-- Follows the same pattern as the commented-out daily-subscriber-reset
-- cron in 001_subscriber_tables.sql.
-- ============================================================
do $do$
begin
	-- Idempotent: replace existing schedule if this migration is replayed.
	if exists (select 1 from cron.job where jobname = 'chat-worker-tick') then
		perform cron.unschedule('chat-worker-tick');
	end if;

	perform cron.schedule(
		'chat-worker-tick',
		'10 seconds',
		$job$
		select net.http_post(
			url := 'https://afsxspzcofonavdgmeyf.supabase.co/functions/v1/chat-worker',
			headers := jsonb_build_object(
				'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
				'Content-Type',  'application/json'
			),
			body := '{}'::jsonb
		);
		$job$
	);
end
$do$;
