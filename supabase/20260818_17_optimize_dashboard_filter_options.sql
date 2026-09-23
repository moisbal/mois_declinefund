-- Dashboard filter options and year counts in one RLS-respecting request.
-- Prerequisite: the existing projects table and its RLS policies are applied.
-- This function is SECURITY INVOKER, so it returns only projects visible to the caller.

create or replace function public.get_dashboard_filter_options()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with visible_projects as (
    select
      year,
      nullif(btrim(sido), '') as sido,
      nullif(btrim(sigungu), '') as sigungu,
      nullif(btrim(region_type), '') as region_type,
      nullif(btrim(category), '') as category
    from public.projects
    where project_code is not null
  ),
  year_counts as (
    select coalesce(jsonb_object_agg(year::text, project_count), '{}'::jsonb) as value
    from (
      select year, count(*)::integer as project_count
      from visible_projects
      where year is not null
      group by year
      order by year
    ) as grouped_years
  ),
  sido_values as (
    select coalesce(jsonb_agg(sido order by sido), '[]'::jsonb) as value
    from (
      select distinct sido
      from visible_projects
      where sido is not null
    ) as distinct_sidos
  ),
  sigungu_values as (
    select coalesce(jsonb_object_agg(sido, sigungus), '{}'::jsonb) as value
    from (
      select sido, jsonb_agg(sigungu order by sigungu) as sigungus
      from (
        select distinct sido, sigungu
        from visible_projects
        where sido is not null and sigungu is not null
      ) as distinct_sigungus
      group by sido
    ) as grouped_sigungus
  ),
  region_type_values as (
    select coalesce(jsonb_agg(region_type order by region_type), '[]'::jsonb) as value
    from (
      select distinct region_type
      from visible_projects
      where region_type is not null
    ) as distinct_region_types
  ),
  category_values as (
    select coalesce(jsonb_agg(category order by category), '[]'::jsonb) as value
    from (
      select distinct category
      from visible_projects
      where category is not null
    ) as distinct_categories
  )
  select jsonb_build_object(
    'year_counts', year_counts.value,
    'sidos', sido_values.value,
    'sigungus_by_sido', sigungu_values.value,
    'region_types', region_type_values.value,
    'categories', category_values.value
  )
  from year_counts, sido_values, sigungu_values, region_type_values, category_values;
$$;

revoke all on function public.get_dashboard_filter_options() from public;
revoke all on function public.get_dashboard_filter_options() from anon;
grant execute on function public.get_dashboard_filter_options() to authenticated;
