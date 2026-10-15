import { useEffect, useState } from 'react';

function Resource({ resource }: { resource: any }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (typeof resource.blob !== 'string' || resource.blob.length > 8_000_000) return;
    try { const bytes = Uint8Array.from(atob(resource.blob), c => c.charCodeAt(0)); const link = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' })); setUrl(link); return () => URL.revokeObjectURL(link); } catch { return; }
  }, [resource.blob]);
  if (resource.text) return <details><summary>{resource.uri ?? 'Document'}</summary><pre className="ctx">{resource.text}</pre></details>;
  return url ? <a href={url} download="document">Télécharger le document ({resource.mimeType})</a> : <span>Ressource : {resource.uri ?? 'non disponible'}</span>;
}
export function Media({ blocks }: { blocks: any[] }) {
  return <div className="media-response">{blocks.map((b, i) => {
    if (typeof b.data === 'string' && b.data.length <= 8_000_000 && /^[A-Za-z0-9+/=]+$/.test(b.data)) {
      if (b.type === 'image' && /^image\/(png|jpeg|gif|webp)$/.test(b.mimeType)) return <img key={i} src={`data:${b.mimeType};base64,${b.data}`} alt="Image transmise par l’agent" />;
      if (b.type === 'audio' && /^audio\/(mpeg|wav|ogg|webm|mp4)$/.test(b.mimeType)) return <audio key={i} controls src={`data:${b.mimeType};base64,${b.data}`} />;
    }
    if (b.type === 'resource' && b.resource) return <Resource key={i} resource={b.resource} />;
    if (b.type === 'resource_link' && /^(https?:\/\/)/.test(b.uri)) return <a key={i} href={b.uri} target="_blank" rel="noreferrer">{b.name ?? b.uri}</a>;
    return <p key={i}>Contenu {b.type} non affichable dans ce navigateur.</p>;
  })}</div>;
}
