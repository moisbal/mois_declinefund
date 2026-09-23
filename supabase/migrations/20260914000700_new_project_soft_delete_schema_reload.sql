-- Refresh PostgREST's schema cache after the additive soft-delete columns and
-- RPCs are installed through the guarded TEST migration runner.
notify pgrst, 'reload schema';

