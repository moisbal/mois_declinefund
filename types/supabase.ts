export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          email: string | null;
          login_id: string | null;
          name: string | null;
          role: 'admin' | 'local_user';
          region_id: string | null;
          region_name: string | null;
          first_login: boolean;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          id?: string;
          email?: string | null;
          login_id?: string | null;
          name?: string | null;
          role: 'admin' | 'local_user';
          region_id?: string | null;
          region_name?: string | null;
          first_login?: boolean;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          email?: string | null;
          login_id?: string | null;
          name?: string | null;
          role?: 'admin' | 'local_user';
          region_id?: string | null;
          region_name?: string | null;
          first_login?: boolean;
          created_at?: string | null;
          updated_at?: string | null;
        };
      };
      regions: {
        Row: {
          id: string;
          region_code: string | null;
          sido: string | null;
          sigungu: string | null;
          region_type: string | null;
          display_name: string | null;
          population: number | null;
          elderly_rate: number | null;
          net_migration_2025: number | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          id?: string;
          region_code?: string | null;
          sido?: string | null;
          sigungu?: string | null;
          region_type?: string | null;
          display_name?: string | null;
          population?: number | null;
          elderly_rate?: number | null;
          net_migration_2025?: number | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          region_code?: string | null;
          sido?: string | null;
          sigungu?: string | null;
          region_type?: string | null;
          display_name?: string | null;
          population?: number | null;
          elderly_rate?: number | null;
          net_migration_2025?: number | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
      };
      projects: {
        Row: {
          id: string;
          project_id: string;
          project_code: string | null;
          region_id: string;
          year: number | null;
          region_type: string | null;
          sido: string | null;
          sigungu: string | null;
          project_name: string | null;
          fund_project_name: string | null;
          detail_project_name: string | null;
          project_period: string | null;
          project_start_year: number | null;
          project_end_year: number | null;
          category: string | null;
          project_type: string | null;
          large_category_id: string | null;
          middle_category_id: string | null;
          business_type: 'HW' | 'SW' | 'COMPOSITE' | null;
          total_budget: number | null;
          original_alloc: number | null;
          increase_amount: number | null;
          decrease_amount: number | null;
          alloc: number | null;
          exec: number | null;
          rate: number | null;
          period: string | null;
          status: string | null;
          execution_status_reason: string | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          id?: string;
          project_id: string;
          project_code?: string | null;
          region_id: string;
          year?: number | null;
          region_type?: string | null;
          sido?: string | null;
          sigungu?: string | null;
          project_name?: string | null;
          fund_project_name?: string | null;
          detail_project_name?: string | null;
          project_period?: string | null;
          project_start_year?: number | null;
          project_end_year?: number | null;
          category?: string | null;
          project_type?: string | null;
          large_category_id?: string | null;
          middle_category_id?: string | null;
          business_type?: 'HW' | 'SW' | 'COMPOSITE' | null;
          total_budget?: number | null;
          original_alloc?: number | null;
          increase_amount?: number | null;
          decrease_amount?: number | null;
          alloc?: number | null;
          exec?: number | null;
          rate?: number | null;
          period?: string | null;
          status?: string | null;
          execution_status_reason?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          project_id?: string;
          project_code?: string | null;
          region_id?: string;
          year?: number | null;
          region_type?: string | null;
          sido?: string | null;
          sigungu?: string | null;
          project_name?: string | null;
          fund_project_name?: string | null;
          detail_project_name?: string | null;
          project_period?: string | null;
          project_start_year?: number | null;
          project_end_year?: number | null;
          category?: string | null;
          project_type?: string | null;
          large_category_id?: string | null;
          middle_category_id?: string | null;
          business_type?: 'HW' | 'SW' | 'COMPOSITE' | null;
          total_budget?: number | null;
          original_alloc?: number | null;
          increase_amount?: number | null;
          decrease_amount?: number | null;
          alloc?: number | null;
          exec?: number | null;
          rate?: number | null;
          period?: string | null;
          status?: string | null;
          execution_status_reason?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
      };
      large_categories: {
        Row: {
          id: string;
          code: string;
          name: string;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          id?: string;
          code: string;
          name: string;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          code?: string;
          name?: string;
          created_at?: string | null;
          updated_at?: string | null;
        };
      };
      middle_categories: {
        Row: {
          id: string;
          code: string;
          name: string;
          large_category_id: string;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          id?: string;
          code: string;
          name: string;
          large_category_id: string;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          code?: string;
          name?: string;
          large_category_id?: string;
          created_at?: string | null;
          updated_at?: string | null;
        };
      };
      small_categories: {
        Row: {
          id: string;
          code: string;
          name: string;
          large_category_id: string;
          middle_category_id: string;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          id?: string;
          code: string;
          name: string;
          large_category_id: string;
          middle_category_id: string;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          code?: string;
          name?: string;
          large_category_id?: string;
          middle_category_id?: string;
          created_at?: string | null;
          updated_at?: string | null;
        };
      };
      project_small_categories: {
        Row: {
          id: string;
          project_id: string;
          small_category_id: string;
          created_at: string | null;
        };
        Insert: {
          id?: string;
          project_id: string;
          small_category_id: string;
          created_at?: string | null;
        };
        Update: {
          project_id?: string;
          small_category_id?: string;
          created_at?: string | null;
        };
      };
      project_category_aliases: {
        Row: {
          id: string;
          alias: string;
          normalized_alias: string;
          large_category_id: string;
          middle_category_id: string;
          small_category_id: string | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          id?: string;
          alias: string;
          normalized_alias: string;
          large_category_id: string;
          middle_category_id: string;
          small_category_id?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          alias?: string;
          normalized_alias?: string;
          large_category_id?: string;
          middle_category_id?: string;
          small_category_id?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
      };
      project_custom_small_categories: {
        Row: {
          id: string;
          project_id: string;
          input_value: string;
          normalized_value: string;
          large_category_id: string;
          middle_category_id: string;
          suggested_small_category_id: string | null;
          classification_method: string;
          confidence: number;
          validation_status: 'PENDING_REVIEW' | 'CONFIRMED' | 'REJECTED';
          created_by: string;
          reviewed_by: string | null;
          reviewed_at: string | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          id?: string;
          project_id: string;
          input_value: string;
          normalized_value: string;
          large_category_id: string;
          middle_category_id: string;
          suggested_small_category_id?: string | null;
          classification_method: string;
          confidence?: number;
          validation_status?: 'PENDING_REVIEW' | 'CONFIRMED' | 'REJECTED';
          created_by: string;
          reviewed_by?: string | null;
          reviewed_at?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          input_value?: string;
          normalized_value?: string;
          large_category_id?: string;
          middle_category_id?: string;
          suggested_small_category_id?: string | null;
          classification_method?: string;
          confidence?: number;
          validation_status?: 'PENDING_REVIEW' | 'CONFIRMED' | 'REJECTED';
          reviewed_by?: string | null;
          reviewed_at?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
      };
      project_related_projects: {
        Row: {
          id: string;
          project_id: string;
          project_name: string;
          total_budget: number;
          regional_fund_alloc: number;
          local_fund_alloc: number;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          id?: string;
          project_id: string;
          project_name: string;
          total_budget?: number;
          regional_fund_alloc?: number;
          local_fund_alloc?: number;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          project_id?: string;
          project_name?: string;
          total_budget?: number;
          regional_fund_alloc?: number;
          local_fund_alloc?: number;
          created_at?: string | null;
          updated_at?: string | null;
        };
      };
      audit_logs: {
        Row: {
          id: string;
          project_id: string;
          region_id: string | null;
          field_name: string | null;
          old_value: string | null;
          new_value: string | null;
          action: string | null;
          changed_by: string;
          changed_at: string | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          id?: string;
          project_id: string;
          region_id?: string | null;
          action?: string | null;
          field_name?: string | null;
          old_value?: string | null;
          new_value?: string | null;
          changed_by: string;
          changed_at?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          project_id?: string;
          region_id?: string | null;
          action?: string | null;
          field_name?: string | null;
          old_value?: string | null;
          new_value?: string | null;
          changed_by?: string;
          changed_at?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
      };
    };
  };
}
