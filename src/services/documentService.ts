import { supabase } from '@/lib/supabase'

const BUCKET = 'project-documents'

/** How long a generated download link stays valid. */
const SIGNED_URL_TTL_SECONDS = 300 // 5 minutes

export interface ProjectDocument {
  id: string
  org_id: string
  project_id: string
  title: string | null
  name: string | null
  file_name: string | null
  file_url: string | null
  file_size_bytes: number | null
  uploaded_by: string | null
  uploaded_at: string | null
  tags: string[]
  created_at: string
}

export const documentService = {
  async listByProject(projectId: string): Promise<ProjectDocument[]> {
    const { data, error } = await supabase
      .from('project_documents')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })

    if (error) throw error
    return (data ?? []) as ProjectDocument[]
  },

  async upload(
    orgId: string,
    projectId: string,
    file: File,
    title: string,
    userId: string,
  ): Promise<ProjectDocument> {
    // Sanitise the file name so it can't break out of the org/project prefix
    // via "../" or contain separators / control characters. Keep only
    // letters, digits, dot, dash, underscore; everything else → underscore.
    // Cap at 120 chars to avoid hitting Supabase Storage path limits.
    const safeName = (file.name || 'upload')
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^\.+/, '')
      .slice(0, 120) || 'upload'
    const filePath = `${orgId}/${projectId}/${Date.now()}_${safeName}`

    // Upload to Supabase Storage
    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(filePath, file)

    if (uploadError) throw uploadError

    // Store the STORAGE PATH, not a URL.
    //
    // This used to call getPublicUrl(), which only produces a working link on
    // a PUBLIC bucket — meaning every grant agreement, contract and financial
    // annex was readable by anyone who had the link, with no login and no
    // expiry. The bucket is now private and links are minted on demand by
    // getDownloadUrl() below, valid for a few minutes.
    const { data, error } = await supabase
      .from('project_documents')
      .insert({
        org_id: orgId,
        project_id: projectId,
        title,
        name: file.name,
        file_name: file.name,
        file_url: filePath,
        file_size_bytes: file.size,
        uploaded_by: userId,
        uploaded_at: new Date().toISOString(),
        tags: [],
      })
      .select()
      .single()

    if (error) throw error
    return data as ProjectDocument
  },

  /**
   * Mint a short-lived, authenticated download link for a document.
   * Call this at click time — never store the result.
   */
  async getDownloadUrl(fileUrl: string | null): Promise<string | null> {
    const path = toStoragePath(fileUrl)
    if (!path) return null

    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(path, SIGNED_URL_TTL_SECONDS)

    if (error) throw error
    return data?.signedUrl ?? null
  },

  async remove(id: string, fileUrl: string | null): Promise<void> {
    const path = toStoragePath(fileUrl)
    if (path) {
      await supabase.storage.from(BUCKET).remove([path])
    }

    const { error } = await supabase
      .from('project_documents')
      .delete()
      .eq('id', id)

    if (error) throw error
  },
}

/**
 * Normalise a stored `file_url` to a storage path.
 *
 * Rows created before this change hold a full public URL; new rows hold the
 * bare path. Handle both so existing documents keep working.
 */
function toStoragePath(fileUrl: string | null): string | null {
  if (!fileUrl) return null
  const marker = `/${BUCKET}/`
  const idx = fileUrl.indexOf(marker)
  if (idx >= 0) {
    // Legacy public URL: .../storage/v1/object/public/project-documents/<path>
    return decodeURIComponent(fileUrl.slice(idx + marker.length).split('?')[0])
  }
  // Already a storage path.
  return fileUrl.replace(/^\/+/, '')
}
