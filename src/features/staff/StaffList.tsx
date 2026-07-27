import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useStaff } from '@/hooks/useStaff'
import type { StaffFilters } from '@/services/staffService'
import { staffService } from '@/services/staffService'
import { absenceService } from '@/services/absenceService'
import { useAuthStore } from '@/stores/authStore'
import { generateStaffListPDF } from '@/services/reportGenerator'
import { ImportExportButtons } from '@/components/common/ImportExportButtons'
import { PageHeader } from '@/components/layout/PageHeader'
import { SkeletonTable } from '@/components/common/SkeletonTable'
import { EmptyState } from '@/components/common/EmptyState'
import { ErrorState } from '@/components/common/ErrorState'
import { ConfirmModal } from '@/components/common/ConfirmModal'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { toast } from '@/components/ui/use-toast'
import { Plus, Search, Trash2, Pencil, Users } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PersonAvatar } from '@/components/common/PersonAvatar'
import type { Person } from '@/types'
import { ImportDialog } from '@/components/import/ImportDialog'
import { exportToExcel } from '@/lib/exportUtils'
import { usePlanLimits } from '@/hooks/usePlanLimits'
import { UpgradeBanner } from '@/components/ui/UpgradeBanner'

export function StaffList() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { can } = useAuthStore()
  const planLimits = usePlanLimits()
  const [search, setSearch] = useState('')
  const [activeFilter, setActiveFilter] = useState<boolean | undefined>(true)
  const [deleteTarget, setDeleteTarget] = useState<Person | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [importAiOpen, setImportAiOpen] = useState(false)

  const filters: StaffFilters = {
    search: search || undefined,
    is_active: activeFilter,
  }
  const { staff, isLoading, isError, refetch } = useStaff(filters)

  // Fetch absence days used per person for the current year
  const currentYear = new Date().getFullYear()
  const [absenceDaysMap, setAbsenceDaysMap] = useState<Record<string, number>>({})
  useEffect(() => {
    if (!staff.length) return
    const fetchDays = async () => {
      const map: Record<string, number> = {}
      await Promise.all(
        staff.map(async (p) => {
          try {
            map[p.id] = await absenceService.getPersonAbsenceDays(p.id, currentYear)
          } catch { map[p.id] = 0 }
        })
      )
      setAbsenceDaysMap(map)
    }
    fetchDays()
  }, [staff, currentYear])

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await staffService.remove(deleteTarget.id)
      toast({ title: t('common.deleted'), description: t('common.hasBeenRemoved', { name: deleteTarget.full_name }) })
      setDeleteTarget(null)
      refetch()
    } catch (err) {
      const message = err instanceof Error ? err.message : t('common.failedToDelete')
      toast({ title: t('common.error'), description: message, variant: 'destructive' })
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('staff.title')}
        description={t('staff.description')}
        actions={
          can('canWrite') ? (
            <div className="flex gap-2">
              <ImportExportButtons
                onImportFile={() => setImportOpen(true)}
                onImportAI={() => setImportAiOpen(true)}
                onExportExcel={() => exportToExcel(
                  staff,
                  [
                    { header: 'Full Name', accessor: (p) => p.full_name },
                    { header: 'Email', accessor: (p) => p.email ?? '' },
                    { header: 'Department', accessor: (p) => p.department ?? '' },
                    { header: 'Role', accessor: (p) => p.role ?? '' },
                    { header: 'Employment Type', accessor: (p) => p.employment_type ?? '' },
                    { header: 'FTE', accessor: (p) => p.fte ?? '' },
                    { header: 'Start Date', accessor: (p) => p.start_date ?? '' },
                    { header: 'End Date', accessor: (p) => p.end_date ?? '' },
                    { header: 'Active', accessor: (p) => p.is_active ? 'Yes' : 'No' },
                  ],
                  'staff_export',
                  'Staff',
                )}
                onExportPDF={() => generateStaffListPDF(staff, '')}
                hasData={staff.length > 0}
              />
              <Button onClick={() => navigate('/staff/new')} disabled={!planLimits.canCreateStaff(staff.length)}>
                <Plus className="mr-2 h-4 w-4" /> {t('staff.addPerson')}
              </Button>
            </div>
          ) : undefined
        }
      />

      {!planLimits.canCreateStaff(staff.length) && (
        <UpgradeBanner message={`You have ${staff.length} staff members. Your plan allows up to ${planLimits.limits.maxStaff}. Upgrade to Pro for unlimited staff.`} />
      )}

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t('staff.searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="flex gap-2">
          {[
            { label: t('common.active'), value: true },
            { label: t('common.inactive'), value: false },
            { label: t('common.all'), value: undefined },
          ].map((opt) => (
            <Button
              key={String(opt.value)}
              variant={activeFilter === opt.value ? 'default' : 'outline'}
              size="sm"
              onClick={() => setActiveFilter(opt.value)}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <SkeletonTable columns={6} rows={8} />
      ) : isError ? (
        <ErrorState onRetry={() => refetch()} />
      ) : staff.length === 0 ? (
        <EmptyState
          icon={Users}
          title={t('staff.noStaff')}
          description={search ? t('common.tryAdjusting') : t('staff.noStaffDesc')}
          action={
            can('canWrite') ? (
              <Button onClick={() => navigate('/staff/new')}>
                <Plus className="mr-2 h-4 w-4" /> {t('staff.addPerson')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
        <div className="text-xs text-muted-foreground mb-2">
          {t('common.showing')} {staff.length} {t('common.items')}
        </div>
        <div className="rounded-lg border">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-3 text-left font-medium sticky top-0 bg-muted/50">{t('common.name')}</th>
                  <th className="px-4 py-3 text-left font-medium sticky top-0 bg-muted/50">{t('staff.department')}</th>
                  <th className="px-4 py-3 text-left font-medium sticky top-0 bg-muted/50">{t('common.role')}</th>
                  <th className="px-4 py-3 text-left font-medium sticky top-0 bg-muted/50">{t('common.type')}</th>
                  <th className="px-4 py-3 text-right font-medium sticky top-0 bg-muted/50">{t('staff.fte')}</th>
                  <th className="px-4 py-3 text-right font-medium sticky top-0 bg-muted/50">{t('staff.leaveBalance')}</th>
                  <th className="px-4 py-3 text-left font-medium sticky top-0 bg-muted/50">{t('common.account')}</th>
                  <th className="px-4 py-3 text-left font-medium sticky top-0 bg-muted/50">{t('common.status')}</th>
                  {can('canWrite') && <th className="px-4 py-3 text-right font-medium sticky top-0 bg-muted/50">{t('common.actions')}</th>}
                </tr>
              </thead>
              <tbody>
                {staff.map((person, idx) => (
                  <tr
                    key={person.id}
                    className={cn(
                      'border-b last:border-0 hover:bg-muted/30 cursor-pointer transition-colors',
                      idx % 2 === 1 && 'bg-muted/[0.03]',
                    )}
                    onClick={() => navigate(`/staff/${person.id}`)}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <PersonAvatar name={person.full_name} avatarUrl={person.avatar_url} size="sm" />
                        <div>
                          <div className="font-medium">{person.full_name}</div>
                          {person.email && (
                            <div className="text-xs text-muted-foreground">{person.email}</div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{person.department ?? '—'}</td>
                    <td className="px-4 py-3 text-muted-foreground">{person.role ?? '—'}</td>
                    <td className="px-4 py-3">
                      <Badge variant="secondary">{person.employment_type}</Badge>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{person.fte.toFixed(2)}</td>
                    <td className="px-4 py-3 text-right">
                      {person.vacation_days_per_year != null ? (() => {
                        const used = absenceDaysMap[person.id] ?? 0
                        const total = person.vacation_days_per_year ?? 0
                        const remaining = total - used
                        return (
                          <div className="flex items-center justify-end gap-1.5">
                            <span className={cn(
                              'text-xs font-semibold tabular-nums',
                              remaining <= 0 ? 'text-red-600' : remaining <= 5 ? 'text-amber-600' : 'text-emerald-600'
                            )}>
                              {remaining}
                            </span>
                            <span className="text-[10px] text-muted-foreground">/ {total}d</span>
                          </div>
                        )
                      })() : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {person.user_id ? (
                        <Badge variant="default" className="bg-green-600 hover:bg-green-700 text-[10px]">{t('common.active')}</Badge>
                      ) : person.invite_status === 'pending' ? (
                        <Badge variant="secondary" className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 text-[10px]">{t('common.invited')}</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={person.is_active ? 'default' : 'outline'}>
                        {person.is_active ? t('common.active') : t('common.inactive')}
                      </Badge>
                    </td>
                    {can('canWrite') && (
                      <td className="px-4 py-3 text-right">
                        <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => navigate(`/staff/${person.id}/edit`)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setDeleteTarget(person)}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        </>
      )}

      <ConfirmModal
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={t('staff.deletePerson')}
        message={t('staff.deletePersonConfirm', { name: deleteTarget?.full_name ?? '' })}
        confirmLabel={t('common.delete')}
        destructive
        loading={deleting}
        onConfirm={handleDelete}
      />

      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        importType="persons"
        onImportComplete={() => refetch()}
      />
      <ImportDialog
        open={importAiOpen}
        onOpenChange={setImportAiOpen}
        importType="persons"
        aiMode
        onImportComplete={() => refetch()}
      />
    </div>
  )
}
