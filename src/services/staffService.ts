import { supabase } from '@/lib/supabase'
import { writeAudit } from './auditWriter'
import type { Person } from '@/types'

export interface StaffFilters {
  search?: string
  department?: string
  employment_type?: string
  is_active?: boolean
}

/**
 * Salary and overhead_rate are sensitive.
 *
 * This used to switch between `persons` and `persons_masked` based on a
 * CLIENT-SIDE permission flag — which protected nothing, because RLS is
 * row-level and any org member could simply request `from('persons')
 * .select('*')` and read every salary in the company.
 *
 * The database now enforces it:
 *   - SELECT on persons.annual_salary / overhead_rate is REVOKED, so those
 *     columns cannot be read from the client at all;
 *   - `persons_secure` returns them only when can_see_salary() is true for the
 *     caller, and scopes rows to the caller's organisation in the view itself.
 *
 * Every read therefore goes through `persons_secure`. Writes still go to the
 * base table, where RLS applies as before.
 */
const PERSONS_VIEW = 'persons_secure'

/**
 * Columns that are safe to read back after a write. `.select()` with no
 * argument means `*`, which now fails because of the revoked salary columns.
 */
const PERSON_WRITE_RETURN_COLUMNS =
  'id, org_id, full_name, email, department, role, employment_type, fte, ' +
  'start_date, end_date, country, region, is_active, avatar_url, ' +
  'vacation_days_per_year, user_id, invite_status, invite_role, ' +
  'created_at, updated_at'

function personsSource() {
  return PERSONS_VIEW
}

export const staffService = {
  async list(orgId: string | null, filters?: StaffFilters): Promise<Person[]> {
    let query = (supabase as any)
      .from(personsSource())
      .select('*')
      .order('full_name')

    if (orgId) {
      query = query.eq('org_id', orgId)
    }

    if (filters?.is_active !== undefined) {
      query = query.eq('is_active', filters.is_active)
    }

    if (filters?.department) {
      query = query.eq('department', filters.department)
    }

    if (filters?.employment_type) {
      query = query.eq('employment_type', filters.employment_type)
    }

    if (filters?.search) {
      query = query.ilike('full_name', `%${filters.search}%`)
    }

    const { data, error } = await query

    if (error) throw error
    return (data ?? []) as Person[]
  },

  async getById(id: string): Promise<Person | null> {
    const { data, error } = await (supabase as any)
      .from(personsSource())
      .select('*')
      .eq('id', id)
      .single()

    if (error) throw error
    return data as Person
  },

  async create(person: Omit<Person, 'id' | 'created_at' | 'updated_at'>): Promise<Person> {
    const { data, error } = await supabase
      .from('persons')
      .insert(person)
      .select(PERSON_WRITE_RETURN_COLUMNS)
      .single()

    if (error) throw error
    const created = data as unknown as Person
    writeAudit({ orgId: person.org_id, entityType: 'person', action: 'create', entityId: created.id, details: `Created person ${person.full_name}` })
    return created
  },

  async update(id: string, updates: Partial<Person>): Promise<Person> {
    const { data, error } = await supabase
      .from('persons')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select(PERSON_WRITE_RETURN_COLUMNS)
      .single()

    if (error) throw error
    const updated = data as unknown as Person
    writeAudit({ orgId: updated.org_id, entityType: 'person', action: 'update', entityId: id, details: `Updated person ${updated.full_name}` })
    return updated
  },

  async remove(id: string): Promise<void> {
    const person = await this.getById(id)
    const { error } = await supabase
      .from('persons')
      .delete()
      .eq('id', id)

    if (error) throw error
    if (person) writeAudit({ orgId: person.org_id, entityType: 'person', action: 'delete', entityId: id, details: `Deleted person ${person.full_name}` })
  },

  async getDepartments(orgId: string | null): Promise<string[]> {
    let query = supabase
      .from('persons')
      .select('department')

    if (orgId) {
      query = query.eq('org_id', orgId)
    }

    const { data, error } = await query

    if (error) throw error

    const departments = new Set<string>()
    for (const row of data ?? []) {
      if (row.department) departments.add(row.department as string)
    }
    return Array.from(departments).sort()
  },
}
