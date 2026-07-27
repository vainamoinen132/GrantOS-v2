import { useState } from 'react'
import { documentService, type ProjectDocument } from '@/services/documentService'
import { useDocuments } from '@/hooks/useDocuments'
import { useAuthStore } from '@/stores/authStore'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfirmModal } from '@/components/common/ConfirmModal'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { toast } from '@/components/ui/use-toast'
import { Upload, FileText, Trash2, ExternalLink } from 'lucide-react'

interface DocumentListProps {
  projectId: string
}

export function DocumentList({ projectId }: DocumentListProps) {
  const { orgId, user, can } = useAuthStore()
  const { documents, isLoading: loading, refetch } = useDocuments(projectId)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ProjectDocument | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [openingId, setOpeningId] = useState<string | null>(null)

  /**
   * Documents live in a PRIVATE bucket now, so there is no permanent URL to
   * put in an href. Mint a short-lived signed link at click time instead.
   */
  const handleOpen = async (doc: ProjectDocument) => {
    setOpeningId(doc.id)
    try {
      const url = await documentService.getDownloadUrl(doc.file_url)
      if (!url) {
        toast({ title: 'Error', description: 'This document is no longer available.', variant: 'destructive' })
        return
      }
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not open the document'
      toast({ title: 'Error', description: message, variant: 'destructive' })
    } finally {
      setOpeningId(null)
    }
  }

  const handleUpload = async () => {
    if (!orgId || !user || !file) return
    setUploading(true)
    try {
      await documentService.upload(orgId, projectId, file, title || file.name, user.id)
      toast({ title: 'Uploaded', description: 'Document uploaded successfully.' })
      setUploadOpen(false)
      setTitle('')
      setFile(null)
      refetch()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed'
      toast({ title: 'Error', description: message, variant: 'destructive' })
    } finally {
      setUploading(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await documentService.remove(deleteTarget.id, deleteTarget.file_url)
      toast({ title: 'Deleted', description: 'Document removed.' })
      setDeleteTarget(null)
      refetch()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete'
      toast({ title: 'Error', description: message, variant: 'destructive' })
    } finally {
      setDeleting(false)
    }
  }

  const formatSize = (bytes: number | null) => {
    if (!bytes) return '—'
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  if (loading) return <Skeleton className="h-32 w-full" />

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Documents</CardTitle>
          {can('canWrite') && (
            <Button size="sm" onClick={() => setUploadOpen(true)}>
              <Upload className="mr-1 h-4 w-4" /> Upload
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {documents.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">No documents uploaded yet.</p>
          ) : (
            <div className="space-y-2">
              {documents.map((doc) => (
                <div key={doc.id} className="flex items-center gap-3 rounded-lg border p-3">
                  <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{doc.title || doc.name || doc.file_name}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatSize(doc.file_size_bytes)} · {doc.uploaded_at ? new Date(doc.uploaded_at).toLocaleDateString() : '—'}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    {doc.file_url && (
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={openingId === doc.id}
                        onClick={() => handleOpen(doc)}
                      >
                        <ExternalLink className="h-4 w-4" />
                      </Button>
                    )}
                    {can('canWrite') && (
                      <Button variant="ghost" size="icon" onClick={() => setDeleteTarget(doc)}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload Document</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Title (optional)</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Document title" />
            </div>
            <div className="space-y-2">
              <Label>File *</Label>
              <Input
                type="file"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUploadOpen(false)}>Cancel</Button>
            <Button onClick={handleUpload} disabled={uploading || !file}>
              {uploading ? 'Uploading...' : 'Upload'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmModal
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete Document"
        message="Are you sure you want to delete this document?"
        confirmLabel="Delete"
        destructive
        loading={deleting}
        onConfirm={handleDelete}
      />
    </>
  )
}
