import { SERVER_IMAGES, type StoredFile } from '@/model';
import { cellClass, RemoveButton, ServiceTable } from './parts';

/**
 * The files a TFTP or FTP server lists: the IOS images every server has, then the ones uploaded
 * to it. An upload with an image's name stands in for the image. Only uploads can be removed.
 */
export function FileList({
  label,
  testId,
  files,
  onChange,
}: {
  label: string;
  testId: string;
  files: readonly StoredFile[];
  onChange: (files: StoredFile[]) => void;
}) {
  const uploaded = new Set(files.map((file) => file.name));
  const images = SERVER_IMAGES.filter((image) => !uploaded.has(image.name));
  return (
    <ServiceTable
      label={label}
      testId={testId}
      columns={[['File'], ['', 'w-7']]}
      empty={undefined}
      scroll
    >
      {images.map((image) => (
        <tr key={image.name} className="border-t border-line">
          <td colSpan={2} className={`${cellClass} text-fg-2`}>
            {image.name}
          </td>
        </tr>
      ))}
      {files.map((file) => (
        <tr key={file.name} className="border-t border-line">
          <td className={cellClass}>{file.name}</td>
          <td className="py-0.5 text-right">
            <RemoveButton
              name={file.name}
              onClick={() => onChange(files.filter((other) => other !== file))}
            />
          </td>
        </tr>
      ))}
    </ServiceTable>
  );
}
