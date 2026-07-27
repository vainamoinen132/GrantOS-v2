import { useState, useEffect, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useDraftKeeper } from '@/lib/draftKeeper'
import { DraftSavePill, DraftRestoreBanner } from '@/components/draft'
import { apiFetch } from '@/lib/apiClient'
import { staffService } from '@/services/staffService'
import { settingsService } from '@/services/settingsService'
import { avatarService } from '@/services/avatarService'
import { emailService } from '@/services/emailService'
import { notificationService } from '@/services/notificationService'
import { useAuthStore } from '@/stores/authStore'
import { useStaffMember, useInvalidateStaff } from '@/hooks/useStaff'
import { PersonAvatar } from '@/components/common/PersonAvatar'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/components/ui/use-toast'
import { ArrowLeft, Save, Upload, X, Mail, UserPlus, Send } from 'lucide-react'
import { COUNTRIES } from '@/data/countries'
import { HOLIDAY_REGIONS } from '@/data/holidayRegions'
import type { InvitableRole } from '@/types'

const INVITABLE_ROLES: InvitableRole[] = ['Admin', 'Project Manager', 'Finance Officer']

const staffSchema = z.object({
  full_name: z.string().min(1, 'Name is required').max(100, 'Max 100 characters'),
  email: z.string().email('Invalid email').nullable().or(z.literal('')),
  department: z.string().max(100).nullable().or(z.literal('')),
  role: z.string().max(100).nullable().or(z.literal('')),
  employment_type: z.enum(['Full-time', 'Part-time', 'Contractor']),
  fte: z.coerce.number().min(0, 'Min 0').max(1, 'Max 1'),
  start_date: z.string().nullable().or(z.literal('')),
  end_date: z.string().nullable().or(z.literal('')),
  annual_salary: z.coerce.number().min(0, 'Must be 0 or greater').nullable().optional(),
  vacation_days_per_year: z.coerce.number().min(0, 'Must be 0 or greater').nullable().optional(),
  country: z.string().max(2).nullable().or(z.literal('')),
  region: z.string().max(10).nullable().or(z.literal('')),
  is_active: z.boolean(),
}).refine((data) => {
  if (data.start_date && data.end_date) {
    return new Date(data.end_date) > new Date(data.start_date)
  }
  return true
}, { message: 'End date must be after start date', path: ['end_date'] })

type StaffFormData = z.infer<typeof staffSchema>

export function StaffForm() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()
  const isEdit = !!id && id !== 'new'
  const { orgId, orgName, user, can } = useAuthStore()
  const { person, isLoading: loadingPerson, refetch: refetchPerson } = useStaffMember(isEdit ? id : undefined)
  const [saving, setSaving] = useState(false)
  const [inviting, setInviting] = useState(false)
  const [departments, setDepartments] = useState<string[]>([])
  const [avatarFile, setAvatarFile] = useState<File | null>(null)
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null)
  const [existingAvatarUrl, setExistingAvatarUrl] = useState<string | null>(null)
  const [removeAvatar, setRemoveAvatar] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [inviteToSystem, setInviteToSystem] = useState(false)
  const [inviteRole, setInviteRole] = useState<InvitableRole>('Project Manager')
  const invalidateStaff = useInvalidateStaff()

  const [orgDefaultVacationDays, setOrgDefaultVacationDays] = useState(25)

  // Fetch org settings (departments + default vacation days)
  useEffect(() => {
    if (!orgId) return
    settingsService.getOrganisation(orgId).then((org) => {
      if (org?.departments) setDepartments(org.departments)
      setOrgDefaultVacationDays((org as any)?.default_vacation_days ?? 25)
    }).catch(() => {})
  }, [orgId])

  const {
    register,
    handleSubmit,
    reset,
    control,
    setValue,
    formState: { errors },
  } = useForm<StaffFormData>({
    resolver: zodResolver(staffSchema),
    defaultValues: {
      full_name: '',
      email: '',
      department: '',
      role: '',
      employment_type: 'Full-time',
      fte: 1,
      start_date: '',
      end_date: '',
      annual_salary: null,
      vacation_days_per_year: 25,
      country: '',
      region: '',
      is_active: true,
    },
  })

  // Apply org default vacation days for new staff once loaded
  useEffect(() => {
    if (!isEdit) {
      setValue('vacation_days_per_year', orgDefaultVacationDays)
    }
  }, [isEdit, orgDefaultVacationDays, setValue])

  // Watch email field to conditionally show invite toggle
  const watchedEmail = useWatch({ control, name: 'email' })
  const hasEmail = !!watchedEmail && watchedEmail.includes('@')

  // Watch country to show region dropdown dynamically
  const watchedCountry = useWatch({ control, name: 'country' })
  const availableRegions = useMemo(() => {
    if (!watchedCountry || !HOLIDAY_REGIONS[watchedCountry]) return []
    return Object.entries(HOLIDAY_REGIONS[watchedCountry]).sort(([, a], [, b]) => a.localeCompare(b))
  }, [watchedCountry])

  // Clear region when country changes and the current region is not valid for the new country
  useEffect(() => {
    if (!watchedCountry || !HOLIDAY_REGIONS[watchedCountry]) {
      setValue('region', '')
    }
  }, [watchedCountry, setValue])

  const [baseline, setBaseline] = useState<StaffFormData | null>(null)

  useEffect(() => {
    if (person) {
      const loaded: StaffFormData = {
        full_name: person.full_name,
        email: person.email ?? '',
        department: person.department ?? '',
        role: person.role ?? '',
        employment_type: person.employment_type,
        fte: person.fte,
        start_date: person.start_date ?? '',
        end_date: person.end_date ?? '',
        annual_salary: person.annual_salary,
        vacation_days_per_year: person.vacation_days_per_year ?? orgDefaultVacationDays,
        country: person.country ?? '',
        region: person.region ?? '',
        is_active: person.is_active,
      }
      reset(loaded)
      setBaseline(loaded)
      setExistingAvatarUrl(person.avatar_url ?? null)
    }
  }, [person, reset, orgDefaultVacationDays])

  // For new-person mode the baseline is the empty defaults once we know
  // the org's default vacation days. Only set it once — otherwise the
  // baseline would keep flipping with every render and mask real edits.
  useEffect(() => {
    if (!isEdit && baseline == null) {
      setBaseline({
        full_name: '',
        email: '',
        department: '',
        role: '',
        employment_type: 'Full-time',
        fte: 1,
        start_date: '',
        end_date: '',
        annual_salary: null,
        vacation_days_per_year: orgDefaultVacationDays,
        country: '',
        region: '',
        is_active: true,
      })
    }
  }, [isEdit, baseline, orgDefaultVacationDays])

  // Watch every form field in one pass so DraftKeeper gets a single,
  // debounced value to diff. useWatch returns a fresh object on each
  // field change — that's what we want for autosave.
  const watched = useWatch({ control }) as StaffFormData

  const draft = useDraftKeeper<StaffFormData>({
    key: {
      orgId: orgId ?? '_no-org',
      userId: user?.id ?? '_anon',
      formKey: 'staff-form',
      recordId: isEdit ? (id ?? 'new') : 'new',
    },
    value: watched,
    setValue: (next) => reset(next),
    enabled: !!orgId && !(isEdit && loadingPerson),
    schemaVersion: 1,
    // Staff records contain personal data — always show the banner, never
    // silent-restore (Decision A).
    silentRestoreWindowMs: 0,
    baseline,
  })

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) {
      toast({ title: t('staff.invalidFile'), description: t('staff.invalidFileDesc'), variant: 'destructive' })
      return
    }
    if (file.size > 2 * 1024 * 1024) {
      toast({ title: t('staff.fileTooLarge'), description: t('staff.fileTooLargeDesc'), variant: 'destructive' })
      return
    }
    setAvatarFile(file)
    setAvatarPreview(URL.createObjectURL(file))
    setRemoveAvatar(false)
  }

  const handleRemoveAvatar = () => {
    setAvatarFile(null)
    setAvatarPreview(null)
    setRemoveAvatar(true)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const onSubmit = async (data: StaffFormData) => {
    setSaving(true)
    try {
      const payload = {
        ...data,
        email: data.email || null,
        department: data.department || null,
        role: data.role || null,
        start_date: data.start_date || null,
        end_date: data.end_date || null,
        annual_salary: data.annual_salary ?? null,
        vacation_days_per_year: data.vacation_days_per_year ?? null,
        country: data.country || null,
        region: data.region || null,
        org_id: orgId ?? '',
      }

      let savedPerson: { id: string }
      if (isEdit) {
        // Detect deactivation: was active before, now inactive
        const wasActive = person?.is_active === true
        const nowInactive = data.is_active === false
        await staffService.update(id, payload)
        savedPerson = { id }
        toast({ title: t('common.updated'), description: t('common.hasBeenUpdated', { name: data.full_name }) })

        // Fire-and-forget: notify person if their account was just deactivated
        if (wasActive && nowInactive && data.email && orgId) {
          const orgLabel = orgName ?? 'your organisation'
          emailService.sendStaffDeactivated({
            to: data.email,
            employeeName: data.full_name,
            orgName: orgLabel,
          }).catch(() => {})
        }
      } else {
        const created = await staffService.create(payload as Parameters<typeof staffService.create>[0])
        savedPerson = created
        toast({ title: t('common.created'), description: t('common.hasBeenCreated', { name: data.full_name }) })

        // Send invitation if requested
        if (inviteToSystem && data.email && orgId) {
          try {
            const res = await apiFetch('/api/members?action=invite-member', {
              method: 'POST',
              body: JSON.stringify({
                email: data.email,
                orgId,
                role: inviteRole,
                invitedBy: user?.id,
                personId: created.id,
              }),
            })
            const inviteData = await res.json()
            if (res.ok) {
              toast({ title: t('staff.invitationSent'), description: t('staff.invitationSentDesc', { email: data.email }) })
              // Send branded invitation email
              const inviteParams = new URLSearchParams({
                type: 'org',
                email: data.email,
                org: orgName ?? 'your organisation',
                role: inviteRole,
                invitedBy: user?.email ?? 'An administrator',
                orgId,
              })
              emailService.sendInvitation({
                invitedEmail: data.email,
                orgName: orgName ?? 'your organisation',
                role: inviteRole,
                invitedByName: user?.email ?? 'An administrator',
                signUpUrl: `${window.location.origin}/invite/accept?${inviteParams.toString()}`,
              }).catch(() => {})
              // Notify admins
              notificationService.getAdminUserIds(orgId).then((adminIds) => {
                notificationService.notifyMany({
                  orgId,
                  userIds: adminIds.filter((uid) => uid !== user?.id),
                  type: 'invitation',
                  title: t('staff.staffMemberInvited'),
                  message: `${data.full_name} (${data.email}) was invited as ${inviteRole}.`,
                  link: '/staff',
                }).catch(() => {})
              }).catch(() => {})
            } else if (res.status === 409) {
              toast({ title: t('settings.alreadyMember'), description: inviteData.error, variant: 'destructive' })
            } else {
              toast({ title: t('staff.invitationFailed'), description: inviteData.error ?? t('staff.couldNotSendInvitation'), variant: 'destructive' })
            }
          } catch {
            toast({ title: t('staff.invitationFailed'), description: t('staff.couldNotReachService'), variant: 'destructive' })
          }
        }
      }

      // Handle avatar upload / removal
      if (avatarFile && orgId) {
        const url = await avatarService.upload(orgId, savedPerson.id, avatarFile)
        await staffService.update(savedPerson.id, { avatar_url: url })
      } else if (removeAvatar && orgId) {
        await avatarService.remove(orgId, savedPerson.id)
        await staffService.update(savedPerson.id, { avatar_url: null })
      }
      invalidateStaff()
      // Committed — drop any in-flight draft so the next visit to this
      // route doesn't offer a stale restore.
      draft.discard()
      navigate('/staff')
    } catch (err) {
      const message = err instanceof Error ? err.message : t('common.failedToSave')
      toast({ title: t('common.error'), description: message, variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  if (isEdit && loadingPerson) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={isEdit ? `${t('common.edit')} ${person?.full_name ?? t('common.person')}` : t('staff.addNewPerson')}
        actions={
          <div className="flex items-center gap-3">
            <DraftSavePill status={draft.status} lastSavedAt={draft.lastSavedAt} />
            <Button variant="outline" onClick={() => navigate('/staff')}>
              <ArrowLeft className="mr-2 h-4 w-4" /> {t('common.back')}
            </Button>
          </div>
        }
      />

      {draft.hasDraft && (
        <DraftRestoreBanner
          ageMs={draft.draftAge}
          onRestore={draft.restore}
          onDiscard={draft.discard}
        />
      )}

      <form onSubmit={handleSubmit(onSubmit)}>
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>{t('staff.basicInformation')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="full_name">{t('staff.fullName')} *</Label>
                <Input id="full_name" {...register('full_name')} />
                {errors.full_name && (
                  <p className="text-sm text-destructive">{errors.full_name.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="email">{t('common.email')}</Label>
                <Input id="email" type="email" {...register('email')} />
                {errors.email && (
                  <p className="text-sm text-destructive">{errors.email.message}</p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="department">{t('staff.departmentTeam')}</Label>
                  <select
                    id="department"
                    {...register('department')}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="">{t('staff.selectDepartment')}</option>
                    {departments.map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="role">{t('staff.roleTitle')}</Label>
                  <Input id="role" {...register('role')} />
                </div>
              </div>

              <div className={availableRegions.length > 0 ? 'grid grid-cols-2 gap-4' : ''}>
                <div className="space-y-2">
                  <Label htmlFor="country">{t('staff.country')}</Label>
                  <select
                    id="country"
                    {...register('country')}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="">{t('common.selectCountry')}</option>
                    {COUNTRIES.map((c) => (
                      <option key={c.code} value={c.code}>{c.name}</option>
                    ))}
                  </select>
                </div>

                {availableRegions.length > 0 && (
                  <div className="space-y-2">
                    <Label htmlFor="region">{t('staff.region')}</Label>
                    <select
                      id="region"
                      {...register('region')}
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <option value="">{t('staff.selectRegion')}</option>
                      {availableRegions.map(([code, name]) => (
                        <option key={code} value={code}>{name}</option>
                      ))}
                    </select>
                    <p className="text-[11px] text-muted-foreground">{t('staff.regionDesc')}</p>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="employment_type">{t('staff.employmentType')}</Label>
                  <select
                    id="employment_type"
                    {...register('employment_type')}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="Full-time">Full-time</option>
                    <option value="Part-time">Part-time</option>
                    <option value="Contractor">Contractor</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="fte">FTE (0–1)</Label>
                  <Input id="fte" type="number" step="0.01" min="0" max="1" {...register('fte')} />
                  {errors.fte && (
                    <p className="text-sm text-destructive">{errors.fte.message}</p>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <Label>{t('staff.photo')} <span className="text-muted-foreground font-normal">({t('common.optional')})</span></Label>
                <div className="flex items-center gap-4">
                  {/* Preview */}
                  {(avatarPreview || (existingAvatarUrl && !removeAvatar)) ? (
                    <div className="relative">
                      <img
                        src={avatarPreview || existingAvatarUrl!}
                        alt="Avatar preview"
                        className="h-14 w-14 rounded-full object-cover border"
                      />
                      <button
                        type="button"
                        onClick={handleRemoveAvatar}
                        className="absolute -top-1 -right-1 rounded-full bg-destructive text-destructive-foreground h-5 w-5 flex items-center justify-center hover:bg-destructive/80"
                        title="Remove photo"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ) : (
                    <PersonAvatar name={person?.full_name || 'New'} size="md" className="h-14 w-14 text-base" />
                  )}
                  <div className="space-y-1.5">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      onChange={handleFileChange}
                      className="hidden"
                      id="avatar-upload"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Upload className="mr-1.5 h-3.5 w-3.5" />
                      {existingAvatarUrl && !removeAvatar ? t('staff.changePhoto') : t('staff.uploadPhoto')}
                    </Button>
                    <p className="text-[11px] text-muted-foreground">JPG, PNG or GIF. Max 2 MB.</p>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="is_active"
                  {...register('is_active')}
                  className="h-4 w-4 rounded border-gray-300"
                />
                <Label htmlFor="is_active">{t('staff.active')}</Label>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('staff.datesFinancial')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="start_date">{t('staff.startDate')}</Label>
                  <Input id="start_date" type="date" {...register('start_date')} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="end_date">{t('staff.endDate')}</Label>
                  <Input id="end_date" type="date" {...register('end_date')} />
                  {errors.end_date && (
                    <p className="text-sm text-destructive">{errors.end_date.message}</p>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="vacation_days_per_year">{t('staff.vacationDaysYear')}</Label>
                <Input
                  id="vacation_days_per_year"
                  type="number"
                  step="0.5"
                  min="0"
                  {...register('vacation_days_per_year')}
                  placeholder="e.g. 25"
                />
                {errors.vacation_days_per_year && (
                  <p className="text-sm text-destructive">{errors.vacation_days_per_year.message}</p>
                )}
                <p className="text-[11px] text-muted-foreground">{t('staff.vacationDaysDesc')}</p>
              </div>

              {can('canSeeSalary') && (
                <div className="space-y-2">
                  <Label htmlFor="annual_salary">{t('staff.annualSalary')}</Label>
                  <Input
                    id="annual_salary"
                    type="number"
                    step="0.01"
                    {...register('annual_salary')}
                  />
                  {errors.annual_salary && (
                    <p className="text-sm text-destructive">{errors.annual_salary.message}</p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* System Access — only on create, when email is provided */}
          {!isEdit && hasEmail && (
            <Card className="lg:col-span-2 border-blue-200 dark:border-blue-900">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <UserPlus className="h-4 w-4 text-blue-600" />
                  {t('staff.systemAccess')}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    id="invite_to_system"
                    checked={inviteToSystem}
                    onChange={(e) => setInviteToSystem(e.target.checked)}
                    className="h-4 w-4 rounded border-gray-300 mt-0.5"
                  />
                  <div className="space-y-1">
                    <Label htmlFor="invite_to_system" className="font-medium">
                      {t('staff.inviteToGrantLume')}
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {t('staff.inviteDesc')}
                    </p>
                  </div>
                </div>

                {inviteToSystem && (
                  <div className="ml-7 space-y-3">
                    <div className="space-y-2">
                      <Label htmlFor="invite_role">{t('staff.systemRole')}</Label>
                      <select
                        id="invite_role"
                        value={inviteRole}
                        onChange={(e) => setInviteRole(e.target.value as InvitableRole)}
                        className="flex h-10 w-full max-w-xs rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {INVITABLE_ROLES.map((r) => (
                          <option key={r} value={r}>{r}</option>
                        ))}
                      </select>
                      <p className="text-xs text-muted-foreground">
                        {t('staff.systemRoleDesc')}
                      </p>
                    </div>
                    <div className="rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-100 dark:border-blue-900 px-3 py-2">
                      <p className="text-xs text-blue-700 dark:text-blue-400 flex items-center gap-1.5">
                        <Mail className="h-3.5 w-3.5 shrink-0" />
                        {t('staff.invitationWillBeSent', { email: watchedEmail })}
                      </p>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Edit mode: show current account status */}
          {isEdit && person && (
            <Card className="lg:col-span-2">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <UserPlus className="h-4 w-4" />
                  {t('staff.systemAccess')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {person.user_id ? (
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center rounded-full bg-green-100 dark:bg-green-900/30 px-2.5 py-0.5 text-xs font-medium text-green-700 dark:text-green-400">
                      {t('staff.accountActive')}
                    </span>
                    <span className="text-sm text-muted-foreground">{t('staff.hasLinkedAccount')}</span>
                  </div>
                ) : person.invite_status === 'pending' ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center rounded-full bg-amber-100 dark:bg-amber-900/30 px-2.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                        {t('staff.invitationPending')}
                      </span>
                      <span className="text-sm text-muted-foreground">{t('staff.invitedAsWaiting', { role: person.invite_role ?? 'Project Manager' })}</span>
                    </div>
                    {person.email && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={inviting}
                        onClick={async () => {
                          if (!orgId || !person.email) return
                          setInviting(true)
                          try {
                            const role: InvitableRole = (person.invite_role as InvitableRole) ?? 'Project Manager'
                            const res = await apiFetch('/api/members?action=invite-member', {
                              method: 'POST',
                              body: JSON.stringify({ email: person.email, orgId, role, invitedBy: user?.id, personId: person.id }),
                            })
                            const d = await res.json()
                            if (res.ok || res.status === 409) {
                              emailService.sendInvitation({ invitedEmail: person.email, orgName: orgName ?? 'your organisation', role, invitedByName: user?.email ?? 'An administrator', signUpUrl: `${window.location.origin}/signup` }).catch(() => {})
                              toast({ title: t('staff.invitationResent'), description: t('staff.invitationSentDesc', { email: person.email }) })
                            } else {
                              toast({ title: t('common.error'), description: d.error ?? t('staff.couldNotSendInvitation'), variant: 'destructive' })
                            }
                          } catch {
                            toast({ title: t('common.error'), description: t('staff.couldNotReachService'), variant: 'destructive' })
                          } finally {
                            setInviting(false)
                          }
                        }}
                      >
                        <Send className="mr-2 h-3.5 w-3.5" />
                        {inviting ? t('staff.sending') : t('staff.resendInvitation')}
                      </Button>
                    )}
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center rounded-full bg-gray-100 dark:bg-gray-800 px-2.5 py-0.5 text-xs font-medium text-gray-600 dark:text-gray-400">
                        {t('staff.noAccount')}
                      </span>
                      <span className="text-sm text-muted-foreground">{t('staff.noSystemAccess')}</span>
                    </div>
                    {person.email && (
                      <div className="space-y-3">
                        <div className="flex items-center gap-3">
                          <div className="space-y-2 flex-1 max-w-xs">
                            <Label htmlFor="edit_invite_role">{t('staff.role')}</Label>
                            <select
                              id="edit_invite_role"
                              value={inviteRole}
                              onChange={(e) => setInviteRole(e.target.value as InvitableRole)}
                              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              {INVITABLE_ROLES.map((r) => (
                                <option key={r} value={r}>{r}</option>
                              ))}
                            </select>
                          </div>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={inviting}
                          onClick={async () => {
                            if (!orgId || !person.email) return
                            setInviting(true)
                            try {
                              const res = await apiFetch('/api/members?action=invite-member', {
                                method: 'POST',
                                body: JSON.stringify({ email: person.email, orgId, role: inviteRole, invitedBy: user?.id, personId: person.id }),
                              })
                              const d = await res.json()
                              if (res.ok) {
                                emailService.sendInvitation({ invitedEmail: person.email, orgName: orgName ?? 'your organisation', role: inviteRole, invitedByName: user?.email ?? 'An administrator', signUpUrl: `${window.location.origin}/signup` }).catch(() => {})
                                toast({ title: t('staff.invitationSent'), description: t('staff.invitationSentDesc', { email: person.email }) })
                                refetchPerson()
                              } else if (res.status === 409) {
                                toast({ title: t('settings.alreadyMember'), description: d.error })
                                refetchPerson()
                              } else {
                                toast({ title: t('common.error'), description: d.error ?? t('staff.couldNotSendInvitation'), variant: 'destructive' })
                              }
                            } catch {
                              toast({ title: t('common.error'), description: t('staff.couldNotReachService'), variant: 'destructive' })
                            } finally {
                              setInviting(false)
                            }
                          }}
                        >
                          <Send className="mr-2 h-3.5 w-3.5" />
                          {inviting ? t('staff.sending') : t('staff.inviteToGrantLume')}
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        <div className="mt-6 flex justify-end gap-4">
          <Button type="button" variant="outline" onClick={() => navigate('/staff')}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={saving}>
            <Save className="mr-2 h-4 w-4" />
            {saving ? t('common.saving') : isEdit ? t('staff.updatePerson') : t('staff.createPerson')}
          </Button>
        </div>
      </form>
    </div>
  )
}
