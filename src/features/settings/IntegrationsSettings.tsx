import { useState, useEffect } from 'react'
import { settingsService } from '@/services/settingsService'
import { useAuthStore } from '@/stores/authStore'
import { logger } from '@/lib/logger'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/components/ui/use-toast'
import { Save, CheckCircle2, XCircle, Eye, EyeOff } from 'lucide-react'

export function IntegrationsSettings() {
  const { orgId } = useAuthStore()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [showKey, setShowKey] = useState(false)

  const [integrationKey, setIntegrationKey] = useState('')
  const [userId, setUserId] = useState('')
  const [accountId, setAccountId] = useState('')
  // WRITE-ONLY. The RSA private key is a signing credential; SELECT on that
  // column is revoked at the database level, so it is never sent to the
  // browser. This field starts empty and is only submitted when the admin
  // actually types a new key. `keyConfigured` reflects whether one is stored.
  const [rsaPrivateKey, setRsaPrivateKey] = useState('')
  const [keyConfigured, setKeyConfigured] = useState(false)
  const [baseUrl, setBaseUrl] = useState('https://demo.docusign.net/restapi')
  const [oauthBaseUrl, setOauthBaseUrl] = useState('https://account-d.docusign.com')

  const isConfigured = !!(integrationKey && userId && accountId && (keyConfigured || rsaPrivateKey))

  useEffect(() => {
    if (!orgId) return
    setLoading(true)
    settingsService.getOrganisation(orgId).then((org) => {
      if (org) {
        setIntegrationKey(org.docusign_integration_key ?? '')
        setUserId(org.docusign_user_id ?? '')
        setAccountId(org.docusign_account_id ?? '')
        setKeyConfigured(!!(org as { docusign_key_configured?: boolean }).docusign_key_configured)
        setBaseUrl(org.docusign_base_url ?? 'https://demo.docusign.net/restapi')
        setOauthBaseUrl(org.docusign_oauth_base_url ?? 'https://account-d.docusign.com')
      }
    }).catch((err) => {
      logger.warn('Failed to load integration settings', { source: 'IntegrationsSettings' }, err)
    }).finally(() => setLoading(false))
  }, [orgId])

  const handleSave = async () => {
    if (!orgId) return
    setSaving(true)
    try {
      await settingsService.updateOrganisation(orgId, {
        docusign_integration_key: integrationKey || null,
        docusign_user_id: userId || null,
        docusign_account_id: accountId || null,
        // Only send the key when a new one was typed — an empty field means
        // "leave the stored key alone", not "delete it".
        ...(rsaPrivateKey ? { docusign_rsa_private_key: rsaPrivateKey } : {}),
        docusign_base_url: baseUrl || null,
        docusign_oauth_base_url: oauthBaseUrl || null,
      })
      if (rsaPrivateKey) {
        setKeyConfigured(true)
        setRsaPrivateKey('')
      }
      toast({ title: 'DocuSign settings saved', description: 'The integration is now active for your organisation.' })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save'
      toast({ title: 'Error', description: message, variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  const handleClearKey = async () => {
    if (!orgId) return
    setSaving(true)
    try {
      await settingsService.updateOrganisation(orgId, { docusign_rsa_private_key: null })
      setKeyConfigured(false)
      setRsaPrivateKey('')
      toast({ title: 'Private key removed', description: 'DocuSign signing is disabled until a new key is saved.' })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to remove the key'
      toast({ title: 'Error', description: message, variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <Skeleton className="h-64 w-full" />

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">DocuSign E-Signature</CardTitle>
              <CardDescription className="mt-1">
                Configure DocuSign to enable electronic signing of timesheets.
                Project Managers can sign their timesheets, and Admins / Finance Officers can review and approve them.
              </CardDescription>
            </div>
            {isConfigured ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-green-50 px-3 py-1 text-xs font-medium text-green-700 ring-1 ring-green-200">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Connected
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-50 px-3 py-1 text-xs font-medium text-gray-500 ring-1 ring-gray-200">
                <XCircle className="h-3.5 w-3.5" />
                Not configured
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="ds-integration-key">Integration Key (Client ID)</Label>
              <Input
                id="ds-integration-key"
                value={integrationKey}
                onChange={(e) => setIntegrationKey(e.target.value)}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              />
              <p className="text-xs text-muted-foreground">Found in DocuSign Admin → Apps → your app → Integration Key</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="ds-user-id">API User ID</Label>
              <Input
                id="ds-user-id"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              />
              <p className="text-xs text-muted-foreground">Found in DocuSign Admin → Users → API User ID</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="ds-account-id">Account ID</Label>
              <Input
                id="ds-account-id"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              />
              <p className="text-xs text-muted-foreground">Found in DocuSign Admin → Account Info</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="ds-env">Environment</Label>
              <select
                id="ds-env"
                value={baseUrl.includes('demo') ? 'demo' : 'production'}
                onChange={(e) => {
                  if (e.target.value === 'demo') {
                    setBaseUrl('https://demo.docusign.net/restapi')
                    setOauthBaseUrl('https://account-d.docusign.com')
                  } else {
                    setBaseUrl('https://na4.docusign.net/restapi')
                    setOauthBaseUrl('https://account.docusign.com')
                  }
                }}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="demo">Demo / Sandbox</option>
                <option value="production">Production</option>
              </select>
              <p className="text-xs text-muted-foreground">Use Demo for testing, switch to Production when ready</p>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="ds-rsa-key">RSA Private Key</Label>
              <div className="flex items-center gap-1">
                {keyConfigured && !rsaPrivateKey && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-green-50 px-2 py-0.5 text-[11px] font-medium text-green-700 ring-1 ring-green-200">
                    <CheckCircle2 className="h-3 w-3" />
                    Key saved
                  </span>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => setShowKey(!showKey)}
                >
                  {showKey ? <EyeOff className="h-3 w-3 mr-1" /> : <Eye className="h-3 w-3 mr-1" />}
                  {showKey ? 'Hide' : 'Show'}
                </Button>
                {keyConfigured && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs text-destructive"
                    disabled={saving}
                    onClick={handleClearKey}
                  >
                    Remove
                  </Button>
                )}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              For security, a saved key is never sent back to the browser. Leave this blank to
              keep the existing key, or paste a new one to replace it.
            </p>
            {showKey ? (
              <textarea
                id="ds-rsa-key"
                value={rsaPrivateKey}
                onChange={(e) => setRsaPrivateKey(e.target.value)}
                placeholder="-----BEGIN RSA PRIVATE KEY-----&#10;...&#10;-----END RSA PRIVATE KEY-----"
                rows={6}
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            ) : (
              <Input
                id="ds-rsa-key"
                type="password"
                value={rsaPrivateKey}
                onChange={(e) => setRsaPrivateKey(e.target.value)}
                placeholder={keyConfigured ? '•••••••••• (key saved — paste to replace)' : 'Paste your RSA private key here'}
              />
            )}
            <p className="text-xs text-muted-foreground">
              Generate a keypair in DocuSign Admin → Apps → your app → RSA Keypairs. Paste the full private key including the BEGIN/END lines.
            </p>
          </div>

          <div className="flex justify-end pt-2">
            <Button onClick={handleSave} disabled={saving}>
              <Save className="mr-1 h-4 w-4" />
              {saving ? 'Saving…' : 'Save DocuSign Settings'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm text-muted-foreground">How it works</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="list-decimal list-inside space-y-1.5 text-sm text-muted-foreground">
            <li>Project Managers fill in their monthly timesheets (hours per project per day)</li>
            <li>They click <strong>Submit</strong> to lock the timesheet, then <strong>Sign with DocuSign</strong></li>
            <li>DocuSign opens an embedded signing ceremony — the PM signs electronically</li>
            <li>Admins and Finance Officers are notified via email and in-app notification</li>
            <li>They can review the signed timesheet and click <strong>Approve</strong> or <strong>Reject</strong></li>
          </ol>
        </CardContent>
      </Card>
    </div>
  )
}
