-- TEST-only alignment of a waiting fund to the source project's business year.

begin;

do $$
declare
  v_runtime public.financial_ledger_runtime%rowtype;
begin
  select * into v_runtime from public.financial_ledger_runtime where singleton = true;
  if not found
     or v_runtime.environment_kind <> 'TEST'
     or v_runtime.mode <> 'TEST'
     or v_runtime.bound_project_ref <> 'reviewtestxxxxxxxxxx' then
    raise exception using errcode = '55000', message =
      '승인된 TEST 신규 운영거래 환경에서만 예정예산 사업연도를 보정할 수 있습니다.';
  end if;
end;
$$;

create temporary table pending_fund_business_year_snapshot on commit drop as
select
  (select count(*) from public.projects)::bigint project_count,
  (select coalesce(sum(coalesce(alloc, 0)), 0) from public.projects)::numeric project_allocation,
  (select coalesce(sum(coalesce(exec, 0)), 0) from public.projects)::numeric project_execution,
  (select count(*) from public.financial_pending_new_project_funds)::bigint pending_count,
  (select coalesce(sum(amount), 0) from public.financial_pending_new_project_funds)::numeric pending_amount,
  (select count(*) from public.financial_unallocated_fund_movements)::bigint movement_count;

create or replace function public.financial_align_unlinked_pending_fund_business_year()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request_year integer;
  v_unlinked boolean;
begin
  select requests.fiscal_year, lines.unlinked_funding_only
    into v_request_year, v_unlinked
  from public.financial_budget_change_request_lines as lines
  join public.financial_budget_change_requests as requests on requests.id = lines.request_id
  where lines.id = new.source_line_id and requests.id = new.source_request_id;
  if coalesce(v_unlinked, false) then
    if new.planned_project_year <> v_request_year + 1 then
      raise exception using errcode = '23514', message =
        '신규사업 예정예산은 출처 사업의 다음 연도여야 합니다.';
    end if;
    new.fiscal_year := v_request_year;
  end if;
  return new;
end;
$$;

drop trigger if exists financial_align_unlinked_pending_fund_business_year
  on public.financial_pending_new_project_funds;
create trigger financial_align_unlinked_pending_fund_business_year
before insert on public.financial_pending_new_project_funds
for each row execute function public.financial_align_unlinked_pending_fund_business_year();

with corrected as (
  update public.financial_pending_new_project_funds as pending
  set fiscal_year = requests.fiscal_year
  from public.financial_budget_change_request_lines as lines,
    public.financial_budget_change_requests as requests
  where lines.id = pending.source_line_id
    and requests.id = pending.source_request_id
    and lines.request_id = requests.id
    and lines.unlinked_funding_only
    and pending.status = 'WAITING'
    and pending.planned_project_year = requests.fiscal_year + 1
    and pending.fiscal_year <> requests.fiscal_year
    and not exists (
      select 1 from public.financial_new_project_requests as new_requests
      where new_requests.source_lot_id = pending.lot_id
        and new_requests.status in ('DRAFT', 'SUBMITTED', 'APPROVED')
    )
    and not exists (
      select 1 from public.financial_pending_new_project_link_requests as links
      where links.pending_fund_id = pending.id
        and links.status in ('SUBMITTED', 'APPROVED', 'APPLIED')
    )
  returning pending.id
)
select count(*) from corrected;

do $$
declare
  v_before pending_fund_business_year_snapshot%rowtype;
  v_after pending_fund_business_year_snapshot%rowtype;
begin
  select * into v_before from pending_fund_business_year_snapshot;
  select
    (select count(*) from public.projects)::bigint,
    (select coalesce(sum(coalesce(alloc, 0)), 0) from public.projects)::numeric,
    (select coalesce(sum(coalesce(exec, 0)), 0) from public.projects)::numeric,
    (select count(*) from public.financial_pending_new_project_funds)::bigint,
    (select coalesce(sum(amount), 0) from public.financial_pending_new_project_funds)::numeric,
    (select count(*) from public.financial_unallocated_fund_movements)::bigint
  into v_after;
  if row(v_before.*) is distinct from row(v_after.*) then
    raise exception using errcode = '55000', message =
      '예정예산 사업연도 보정이 TEST 업무 행 수 또는 금액을 변경했습니다.';
  end if;
  if exists (
    select 1
    from public.financial_pending_new_project_funds as pending
    join public.financial_budget_change_request_lines as lines on lines.id = pending.source_line_id
    join public.financial_budget_change_requests as requests on requests.id = pending.source_request_id
    where lines.unlinked_funding_only and pending.status = 'WAITING'
      and pending.planned_project_year = requests.fiscal_year + 1
      and pending.fiscal_year <> requests.fiscal_year
  ) then
    raise exception using errcode = '55000', message = '예정예산 사업연도 정합성 검증에 실패했습니다.';
  end if;
end;
$$;

commit;
