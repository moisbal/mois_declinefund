-- DRAFT ONLY: DO NOT EXECUTE WITHOUT REVIEW AND APPROVAL.
-- Valid only while no earlier function with the same signature must be restored.

begin;

revoke execute on function public.update_project_exec_with_audit(uuid, bigint) from authenticated;
drop function if exists public.update_project_exec_with_audit(uuid, bigint);

commit;

