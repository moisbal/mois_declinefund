import MyProjectEditShell from '../../../../components/my-projects/MyProjectEditShell';

type MyProjectEditPageProps = {
  params: {
    id: string;
  };
};

export default function MyProjectEditPage({ params }: MyProjectEditPageProps) {
  return <MyProjectEditShell projectId={params.id} />;
}
