-- DRAFT DATA MIGRATION ONLY: execute after 20260818_13_add_project_classification.sql.
--
-- Expands the selectable classification master for the tag-style small-category
-- search. It does not update public.projects or convert any legacy data.
-- The terms are normalized from recurring labels in data/fund_projects_raw.json
-- and remain editable master data, not an automatic migration of 3,895 projects.

begin;

insert into public.middle_categories (code, name, large_category_id)
select values_to_insert.code, values_to_insert.name, large_categories.id
from (
  values
    ('EDU_FACILITY', '교육시설 확충', 'EDUCATION'),
    ('EDU_SETTLEMENT', '교육정주 지원', 'EDUCATION'),
    ('EDU_DIGITAL', '교육 디지털화', 'EDUCATION'),
    ('EDU_LIFELONG', '평생교육·인재양성', 'EDUCATION'),
    ('CARE_FACILITY', '보육시설 확충', 'CHILDCARE'),
    ('CARE_SERVICE', '돌봄·보육서비스', 'CHILDCARE'),
    ('CARE_FAMILY', '가족·양육 지원', 'CHILDCARE'),
    ('CARE_DIGITAL', '보육 운영지원', 'CHILDCARE'),
    ('HEALTH_FACILITY', '지역의료 기반', 'LOCAL_HEALTHCARE'),
    ('HEALTH_CARE', '건강·돌봄 서비스', 'LOCAL_HEALTHCARE'),
    ('HEALTH_DIGITAL', '의료 디지털화', 'LOCAL_HEALTHCARE'),
    ('HEALTH_SETTLEMENT', '의료 정주지원', 'LOCAL_HEALTHCARE'),
    ('CULTURE_FACILITY', '문화관광 기반시설', 'CULTURE_TOURISM'),
    ('CULTURE_CONTENT', '문화관광 콘텐츠', 'CULTURE_TOURISM'),
    ('CULTURE_ARTS', '문화예술·공연', 'CULTURE_TOURISM'),
    ('CULTURE_SPORTS', '체육·레저', 'CULTURE_TOURISM'),
    ('CULTURE_DIGITAL', '관광 디지털화', 'CULTURE_TOURISM'),
    ('CULTURE_SETTLEMENT', '관광 정주지원', 'CULTURE_TOURISM'),
    ('IND_SETTLEMENT_JOBS', '지역정주·일자리', 'INDUSTRY_JOBS'),
    ('IND_LOCAL_SERVICE', '지역서비스 산업', 'INDUSTRY_JOBS'),
    ('HOUSING_RENEWAL', '주거환경 정비', 'HOUSING'),
    ('HOUSING_SETTLEMENT', '정주 지원', 'HOUSING'),
    ('HOUSING_LIVING', '생활환경 연계', 'HOUSING'),
    ('TRANSPORT_NETWORK', '교통망 확충', 'TRANSPORT'),
    ('TRANSPORT_FACILITY', '교통시설 개선', 'TRANSPORT'),
    ('TRANSPORT_SERVICE', '교통서비스', 'TRANSPORT'),
    ('OTHER_LIVING_INFRA', '생활기반 확충', 'OTHER'),
    ('OTHER_COMMUNITY_SERVICE', '주민생활 서비스', 'OTHER'),
    ('OTHER_SETTLEMENT', '인구·정주 지원', 'OTHER'),
    ('OTHER_DIGITAL', '지역 디지털화', 'OTHER')
) as values_to_insert(code, name, large_code)
join public.large_categories as large_categories
  on large_categories.code = values_to_insert.large_code
on conflict (code) do nothing;

insert into public.small_categories (code, name, large_category_id, middle_category_id)
select
  values_to_insert.code,
  values_to_insert.name,
  large_categories.id,
  middle_categories.id
from (
  values
    -- 교육
    ('EDU_RURAL_EDUCATION', '교육(농촌유학)', 'EDUCATION', 'EDU_LOCAL_SCHOOL'),
    ('EDU_YOUTH', '청소년 교육', 'EDUCATION', 'EDU_LOCAL_SCHOOL'),
    ('EDU_PROGRAM', '프로그램 운영', 'EDUCATION', 'EDU_LOCAL_SCHOOL'),
    ('EDU_BUILD_NEW', '건축물(신축 및 매입)', 'EDUCATION', 'EDU_FACILITY'),
    ('EDU_BUILD_REMODEL', '건축물(증축 및 리모델링)', 'EDUCATION', 'EDU_FACILITY'),
    ('EDU_BUILD_REPLACE', '건축물(철거 후 신축)', 'EDUCATION', 'EDU_FACILITY'),
    ('EDU_CLOSED_SCHOOL', '폐교 활용 교육시설', 'EDUCATION', 'EDU_FACILITY'),
    ('EDU_EXPERIENCE', '교육 체험공간', 'EDUCATION', 'EDU_FACILITY'),
    ('EDU_RELOCATION', '교육 이주 및 정착지원', 'EDUCATION', 'EDU_SETTLEMENT'),
    ('EDU_HOUSING_LINK', '교육·주거 연계', 'EDUCATION', 'EDU_SETTLEMENT'),
    ('EDU_PLATFORM', '교육 플랫폼 및 포털구축', 'EDUCATION', 'EDU_DIGITAL'),
    ('EDU_ONLINE', '온라인 학습 지원', 'EDUCATION', 'EDU_DIGITAL'),
    ('EDU_LIFELONG_PROGRAM', '평생교육 프로그램', 'EDUCATION', 'EDU_LIFELONG'),
    ('EDU_TALENT', '지역 인재양성', 'EDUCATION', 'EDU_LIFELONG'),

    -- 보육
    ('CARE_BUILD_NEW', '보육시설 신축·매입', 'CHILDCARE', 'CARE_FACILITY'),
    ('CARE_BUILD_REMODEL', '보육시설 증축·리모델링', 'CHILDCARE', 'CARE_FACILITY'),
    ('CARE_CLOSED_SCHOOL', '폐교 활용 보육시설', 'CHILDCARE', 'CARE_FACILITY'),
    ('CARE_PARENTING', '육아(산후조리원, 키즈카페 등 포함)', 'CHILDCARE', 'CARE_SERVICE'),
    ('CARE_PROGRAM', '돌봄 프로그램 운영', 'CHILDCARE', 'CARE_SERVICE'),
    ('CARE_YOUTH', '청소년 돌봄', 'CHILDCARE', 'CARE_SERVICE'),
    ('CARE_EXPERIENCE', '체험형 돌봄공간', 'CHILDCARE', 'CARE_SERVICE'),
    ('CARE_FAMILY_WOMEN', '여성·가족 지원', 'CHILDCARE', 'CARE_FAMILY'),
    ('CARE_SETTLEMENT', '양육가정 정착지원', 'CHILDCARE', 'CARE_FAMILY'),
    ('CARE_PET', '반려동물 돌봄 연계', 'CHILDCARE', 'CARE_FAMILY'),
    ('CARE_PLATFORM', '보육 플랫폼 및 포털구축', 'CHILDCARE', 'CARE_DIGITAL'),
    ('CARE_OPERATING', '보육 운영비 지원', 'CHILDCARE', 'CARE_DIGITAL'),

    -- 지역의료
    ('HEALTH_BUILD_NEW', '의료시설 신축·매입', 'LOCAL_HEALTHCARE', 'HEALTH_FACILITY'),
    ('HEALTH_BUILD_REMODEL', '의료시설 증축·리모델링', 'LOCAL_HEALTHCARE', 'HEALTH_FACILITY'),
    ('HEALTH_BUILD_REPLACE', '의료시설 철거 후 신축', 'LOCAL_HEALTHCARE', 'HEALTH_FACILITY'),
    ('HEALTH_PROGRAM', '지역 건강관리 프로그램', 'LOCAL_HEALTHCARE', 'HEALTH_CARE'),
    ('HEALTH_OPERATING', '의료 운영비 지원', 'LOCAL_HEALTHCARE', 'HEALTH_CARE'),
    ('HEALTH_EXPERIENCE', '건강 체험공간', 'LOCAL_HEALTHCARE', 'HEALTH_CARE'),
    ('HEALTH_PLATFORM', '의료 플랫폼 및 포털구축', 'LOCAL_HEALTHCARE', 'HEALTH_DIGITAL'),
    ('HEALTH_REMOTE', '비대면 의료·건강관리', 'LOCAL_HEALTHCARE', 'HEALTH_DIGITAL'),
    ('HEALTH_PERSONNEL', '의료인력 정착지원', 'LOCAL_HEALTHCARE', 'HEALTH_SETTLEMENT'),
    ('HEALTH_HOUSING_LINK', '의료·주거 연계', 'LOCAL_HEALTHCARE', 'HEALTH_SETTLEMENT'),

    -- 문화관광
    ('CULTURE_BUILD_NEW', '건축물(신축 및 매입)', 'CULTURE_TOURISM', 'CULTURE_FACILITY'),
    ('CULTURE_BUILD_REMODEL', '건축물(증축 및 리모델링)', 'CULTURE_TOURISM', 'CULTURE_FACILITY'),
    ('CULTURE_BUILD_REPLACE', '건축물(철거 후 신축)', 'CULTURE_TOURISM', 'CULTURE_FACILITY'),
    ('CULTURE_CLOSED_SCHOOL', '폐교 활용 문화시설', 'CULTURE_TOURISM', 'CULTURE_FACILITY'),
    ('CULTURE_EXPERIENCE', '체험공간', 'CULTURE_TOURISM', 'CULTURE_CONTENT'),
    ('CULTURE_PROGRAM', '프로그램 운영', 'CULTURE_TOURISM', 'CULTURE_CONTENT'),
    ('CULTURE_PET', '반려동물 관광', 'CULTURE_TOURISM', 'CULTURE_CONTENT'),
    ('CULTURE_PERFORMANCE', '공연', 'CULTURE_TOURISM', 'CULTURE_ARTS'),
    ('CULTURE_ART', '예술', 'CULTURE_TOURISM', 'CULTURE_ARTS'),
    ('CULTURE_PARK', '공원', 'CULTURE_TOURISM', 'CULTURE_SPORTS'),
    ('CULTURE_SPORTS_FACILITY', '골프장 등 체육시설', 'CULTURE_TOURISM', 'CULTURE_SPORTS'),
    ('CULTURE_PLATFORM', '플랫폼 및 포털구축', 'CULTURE_TOURISM', 'CULTURE_DIGITAL'),
    ('CULTURE_RELOCATION', '이주 및 정착지원', 'CULTURE_TOURISM', 'CULTURE_SETTLEMENT'),
    ('CULTURE_OPERATING', '운영비 지원', 'CULTURE_TOURISM', 'CULTURE_SETTLEMENT'),

    -- 산업일자리
    ('IND_BUSINESS_PROGRAM', '기업지원 프로그램', 'INDUSTRY_JOBS', 'IND_BUSINESS_STARTUP'),
    ('IND_BUSINESS_OPERATING', '기업 운영비 지원', 'INDUSTRY_JOBS', 'IND_BUSINESS_STARTUP'),
    ('IND_BUSINESS_PLATFORM', '산업 플랫폼 및 포털구축', 'INDUSTRY_JOBS', 'IND_BUSINESS_STARTUP'),
    ('IND_BASE_BUILD_NEW', '산업기반 신축·매입', 'INDUSTRY_JOBS', 'IND_INDUSTRIAL_BASE'),
    ('IND_BASE_BUILD_REMODEL', '산업기반 증축·리모델링', 'INDUSTRY_JOBS', 'IND_INDUSTRIAL_BASE'),
    ('IND_BASE_BUILD_REPLACE', '산업기반 철거 후 신축', 'INDUSTRY_JOBS', 'IND_INDUSTRIAL_BASE'),
    ('IND_PRIMARY_RURAL_STUDY', '농촌유학 연계', 'INDUSTRY_JOBS', 'IND_PRIMARY_INDUSTRY'),
    ('IND_PRIMARY_EXPERIENCE', '농림어업 체험공간', 'INDUSTRY_JOBS', 'IND_PRIMARY_INDUSTRY'),
    ('IND_YOUTH_JOB', '청년 일자리', 'INDUSTRY_JOBS', 'IND_SETTLEMENT_JOBS'),
    ('IND_RELOCATION', '이주 및 정착지원', 'INDUSTRY_JOBS', 'IND_SETTLEMENT_JOBS'),
    ('IND_RENTAL_LINK', '임대주택 연계', 'INDUSTRY_JOBS', 'IND_SETTLEMENT_JOBS'),
    ('IND_LOCAL_PROGRAM', '지역서비스 프로그램 운영', 'INDUSTRY_JOBS', 'IND_LOCAL_SERVICE'),
    ('IND_LOCAL_EXPERIENCE', '지역서비스 체험공간', 'INDUSTRY_JOBS', 'IND_LOCAL_SERVICE'),

    -- 주거
    ('HOUSING_RENTAL', '임대주택', 'HOUSING', 'HOUSING_PUBLIC'),
    ('HOUSING_BUILD_NEW', '공공주택 신축·매입', 'HOUSING', 'HOUSING_PUBLIC'),
    ('HOUSING_REMODEL', '건축물(증축 및 리모델링)', 'HOUSING', 'HOUSING_RENEWAL'),
    ('HOUSING_REPLACE', '건축물(철거 후 신축)', 'HOUSING', 'HOUSING_RENEWAL'),
    ('HOUSING_EMPTY_HOME', '빈집 철거 후 신축', 'HOUSING', 'HOUSING_RENEWAL'),
    ('HOUSING_REPAIR', '주택정비', 'HOUSING', 'HOUSING_RENEWAL'),
    ('HOUSING_RELOCATION', '이주 및 정착지원', 'HOUSING', 'HOUSING_SETTLEMENT'),
    ('HOUSING_PROGRAM', '정주 프로그램 운영', 'HOUSING', 'HOUSING_SETTLEMENT'),
    ('HOUSING_RURAL_STUDY', '농촌유학 연계 주거', 'HOUSING', 'HOUSING_SETTLEMENT'),
    ('HOUSING_PLATFORM', '주거 플랫폼 및 포털구축', 'HOUSING', 'HOUSING_LIVING'),
    ('HOUSING_PARK', '생활공원', 'HOUSING', 'HOUSING_LIVING'),
    ('HOUSING_SPORTS', '생활체육시설', 'HOUSING', 'HOUSING_LIVING'),

    -- 교통
    ('TRANSPORT_ROAD_SEA', '교통(도로,교량,해운 등 포함)', 'TRANSPORT', 'TRANSPORT_NETWORK'),
    ('TRANSPORT_AIR', '항공(공항)', 'TRANSPORT', 'TRANSPORT_NETWORK'),
    ('TRANSPORT_BUILD_NEW', '교통시설 신축·매입', 'TRANSPORT', 'TRANSPORT_FACILITY'),
    ('TRANSPORT_BUILD_REMODEL', '교통시설 증축·리모델링', 'TRANSPORT', 'TRANSPORT_FACILITY'),
    ('TRANSPORT_BUILD_REPLACE', '교통시설 철거 후 신축', 'TRANSPORT', 'TRANSPORT_FACILITY'),
    ('TRANSPORT_PROGRAM', '교통서비스 프로그램 운영', 'TRANSPORT', 'TRANSPORT_SERVICE'),
    ('TRANSPORT_OPERATING', '교통 운영비 지원', 'TRANSPORT', 'TRANSPORT_SERVICE'),
    ('TRANSPORT_ACCESS', '교통 취약지역 이동지원', 'TRANSPORT', 'TRANSPORT_SERVICE'),

    -- 기타
    ('OTHER_BUILD_NEW', '건축물(신축 및 매입)', 'OTHER', 'OTHER_LIVING_INFRA'),
    ('OTHER_BUILD_REMODEL', '건축물(증축 및 리모델링)', 'OTHER', 'OTHER_LIVING_INFRA'),
    ('OTHER_BUILD_REPLACE', '건축물(철거 후 신축)', 'OTHER', 'OTHER_LIVING_INFRA'),
    ('OTHER_PARK', '공원', 'OTHER', 'OTHER_LIVING_INFRA'),
    ('OTHER_SPORTS', '골프장 등 체육시설', 'OTHER', 'OTHER_LIVING_INFRA'),
    ('OTHER_PROGRAM', '프로그램 운영', 'OTHER', 'OTHER_COMMUNITY_SERVICE'),
    ('OTHER_OPERATING', '운영비 지원', 'OTHER', 'OTHER_COMMUNITY_SERVICE'),
    ('OTHER_YOUTH', '청소년 지원', 'OTHER', 'OTHER_COMMUNITY_SERVICE'),
    ('OTHER_WOMEN', '여성 지원', 'OTHER', 'OTHER_COMMUNITY_SERVICE'),
    ('OTHER_PET', '반려동물 지원', 'OTHER', 'OTHER_COMMUNITY_SERVICE'),
    ('OTHER_RELOCATION', '이주 및 정착지원', 'OTHER', 'OTHER_SETTLEMENT'),
    ('OTHER_RENTAL_LINK', '임대주택 연계', 'OTHER', 'OTHER_SETTLEMENT'),
    ('OTHER_PLATFORM', '플랫폼 및 포털구축', 'OTHER', 'OTHER_DIGITAL'),
    ('OTHER_DIGITAL_SERVICE', '디지털 주민서비스', 'OTHER', 'OTHER_DIGITAL')
) as values_to_insert(code, name, large_code, middle_code)
join public.large_categories as large_categories
  on large_categories.code = values_to_insert.large_code
join public.middle_categories as middle_categories
  on middle_categories.code = values_to_insert.middle_code
 and middle_categories.large_category_id = large_categories.id
on conflict (code) do nothing;

notify pgrst, 'reload schema';

commit;
